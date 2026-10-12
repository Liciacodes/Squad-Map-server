import express from "express";
import { createServer } from "http";
import { randomUUID } from "crypto";
import { Server, Socket } from "socket.io";
import cors from "cors";

const PORT = Number(process.env.PORT) || 3001;

const app = express();
// hosts like Render sit behind one proxy, this makes req.ip the real client
app.set("trust proxy", 1);
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

interface User {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

// links a browser's secret session key to the person it joined as
interface Session {
  userId: string;
  socketId: string;
  removalTimer?: NodeJS.Timeout;
}

interface Event {
  code: string;
  name: string;
  users: Map<string, User>;
  sessions: Map<string, Session>;
  createdAt: number;
  creatorToken: string;
  expiryTimer: NodeJS.Timeout;
}

interface JoinEventPayload {
  eventCode: string;
  userName: string;
  latitude: number;
  longitude: number;
  sessionKey?: string;
}

interface CreateEventPayload extends JoinEventPayload {
  eventName: string;
}

interface LocationUpdatePayload {
  eventCode: string;
  latitude: number;
  longitude: number;
}

interface EndEventPayload {
  eventCode: string;
  creatorToken: string;
}

const events = new Map<string, Event>();
const EVENT_EXPIRE_TIME = 1000 * 60 * 60; // 1 hour;
const MAX_USER_NAME_LENGTH = 50;
const MAX_EVENT_NAME_LENGTH = 80;
const LOOKUP_WINDOW_MS = 1000 * 60; // 1 minute
const MAX_LOOKUPS_PER_WINDOW = 60;
const MAX_EVENTS = 500;
const MAX_USERS_PER_EVENT = 50;
const MIN_LOCATION_UPDATE_INTERVAL_MS = 1000;
// how long a dropped connection has to come back before others are told it left
// (the tests shorten it through the environment so they don't wait 15 seconds)
const REJOIN_GRACE_MS = Number(process.env.REJOIN_GRACE_MS) || 1000 * 15;

// event lookups per IP, so codes can't be guessed in bulk
const lookups = new Map<string, { count: number; windowStart: number }>();

function isRateLimited(ip: string) {
  const now = Date.now();
  const entry = lookups.get(ip);
  if (!entry || now - entry.windowStart >= LOOKUP_WINDOW_MS) {
    lookups.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_LOOKUPS_PER_WINDOW;
}

// same check without counting, for joins that turn out to be genuine
function isOverLimit(ip: string) {
  const entry = lookups.get(ip);
  return (
    !!entry &&
    Date.now() - entry.windowStart < LOOKUP_WINDOW_MS &&
    entry.count > MAX_LOOKUPS_PER_WINDOW
  );
}

// the real client address, which a proxy such as Render puts last in this header
function clientAddress(socket: Socket) {
  const header = socket.handshake.headers["x-forwarded-for"];
  const forwarded = (Array.isArray(header) ? header.join(",") : header ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return forwarded[forwarded.length - 1] ?? socket.handshake.address;
}

// forget idle IPs so the map does not grow forever
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of lookups) {
    if (now - entry.windowStart >= LOOKUP_WINDOW_MS) lookups.delete(ip);
  }
}, LOOKUP_WINDOW_MS).unref();

// payloads come straight from the client, so check them before use
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isEventCode = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Z0-9]{6}$/.test(value);

const isName = (value: unknown, maxLength: number): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= maxLength;

const isSessionKey = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 16 && value.length <= 64;

const isCoordinate = (value: unknown, limit: number): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  Math.abs(value) <= limit;

function parseLocationUpdate(payload: unknown): LocationUpdatePayload | null {
  if (!isRecord(payload)) return null;
  const { eventCode, latitude, longitude } = payload;
  if (
    !isEventCode(eventCode) ||
    !isCoordinate(latitude, 90) ||
    !isCoordinate(longitude, 180)
  ) {
    return null;
  }
  return { eventCode, latitude, longitude };
}

function parseJoinEvent(payload: unknown): JoinEventPayload | null {
  const location = parseLocationUpdate(payload);
  if (!location || !isRecord(payload)) return null;
  const { userName, sessionKey } = payload;
  if (!isName(userName, MAX_USER_NAME_LENGTH)) return null;
  return {
    ...location,
    userName: userName.trim(),
    sessionKey: isSessionKey(sessionKey) ? sessionKey : undefined,
  };
}

function parseCreateEvent(payload: unknown): CreateEventPayload | null {
  const join = parseJoinEvent(payload);
  if (!join || !isRecord(payload)) return null;
  const { eventName } = payload;
  if (!isName(eventName, MAX_EVENT_NAME_LENGTH)) return null;
  return { ...join, eventName: eventName.trim() };
}

function parseEndEvent(payload: unknown): EndEventPayload | null {
  if (!isRecord(payload)) return null;
  const { eventCode, creatorToken } = payload;
  if (!isEventCode(eventCode) || typeof creatorToken !== "string") return null;
  return { eventCode, creatorToken };
}

// the id of the person on this socket if they are already in the event,
// either on this connection or on an earlier one with the same session key
function findMemberId(socket: Socket, event: Event, sessionKey?: string) {
  const currentId: string | undefined = socket.data.userId;
  if (
    socket.data.eventCode === event.code &&
    currentId &&
    event.users.has(currentId)
  ) {
    return currentId;
  }

  const session = sessionKey ? event.sessions.get(sessionKey) : undefined;
  if (session && event.users.has(session.userId)) return session.userId;

  return undefined;
}

function sendEventUsers(socket: Socket, event: Event, selfId: string) {
  socket.emit("event-users", {
    eventName: event.name,
    createdAt: event.createdAt,
    expiresAt: event.createdAt + EVENT_EXPIRE_TIME,
    // a person's id outlives their connection, so tell the client which one is theirs
    selfId,
    users: Array.from(event.users.values()),
  });
}

function addUserToEvent(
  socket: Socket,
  event: Event,
  { userName, latitude, longitude, sessionKey }: JoinEventPayload,
) {
  const memberId = findMemberId(socket, event, sessionKey);

  if (memberId) {
    const session = sessionKey ? event.sessions.get(sessionKey) : undefined;

    // back on a new connection after a refresh or a drop: keep the same person
    if (
      session &&
      sessionKey &&
      session.userId === memberId &&
      session.socketId !== socket.id
    ) {
      clearTimeout(session.removalTimer);
      session.removalTimer = undefined;
      session.socketId = socket.id;

      const user = event.users.get(memberId)!;
      user.latitude = latitude;
      user.longitude = longitude;

      socket.join(event.code);
      socket.data.eventCode = event.code;
      socket.data.userId = memberId;
      socket.data.sessionKey = sessionKey;

      socket.to(event.code).emit("user-moved", {
        id: memberId,
        latitude,
        longitude,
      });
      console.log(`${user.name} rejoined event ${event.code}`);
    }

    sendEventUsers(socket, event, memberId);
    return;
  }

  // a client that sent no key still gets a session, it just can't be resumed
  const key = sessionKey ?? randomUUID();
  const user: User = {
    id: socket.id,
    name: userName,
    latitude,
    longitude,
  };

  event.users.set(user.id, user);
  event.sessions.set(key, { userId: user.id, socketId: socket.id });

  socket.join(event.code);
  socket.data.eventCode = event.code;
  socket.data.userId = user.id;
  socket.data.sessionKey = key;

  sendEventUsers(socket, event, user.id);
  socket.to(event.code).emit("user-joined", user);

  console.log(`${userName} joined event ${event.code}`);
}

function removeUser(event: Event, userId: string) {
  // the event may have ended while a removal was waiting
  if (events.get(event.code) !== event) return;

  const user = event.users.get(userId);
  if (!user) return;

  event.users.delete(userId);
  for (const [key, session] of event.sessions) {
    if (session.userId === userId) {
      clearTimeout(session.removalTimer);
      event.sessions.delete(key);
    }
  }

  io.to(event.code).emit("user-left", userId, user.name);
}

function leaveCurrentEvent(socket: Socket) {
  const event = events.get(socket.data.eventCode);
  const userId: string | undefined = socket.data.userId;

  socket.data.eventCode = undefined;
  socket.data.userId = undefined;
  socket.data.sessionKey = undefined;

  if (!event || !userId) return;

  socket.leave(event.code);
  removeUser(event, userId);
}

function endEvent(eventCode: string, reason: string) {
  const event = events.get(eventCode);
  if (!event) return;

  clearTimeout(event.expiryTimer);
  for (const session of event.sessions.values()) {
    clearTimeout(session.removalTimer);
  }
  io.to(eventCode).emit("event-ended");
  io.in(eventCode).socketsLeave(eventCode);
  events.delete(eventCode);
  console.log(`Event ${eventCode} ${reason}`);
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("create-event", (payload: unknown) => {
    const data = parseCreateEvent(payload);
    if (!data) {
      socket.emit("event-create-failed", { reason: "invalid" });
      return;
    }

    if (events.has(data.eventCode)) {
      socket.emit("event-create-failed", { reason: "code-taken" });
      return;
    }

    // events live in memory, so cap how many can exist at once
    if (events.size >= MAX_EVENTS) {
      socket.emit("event-create-failed", { reason: "server-full" });
      return;
    }

    // one connection belongs to one event at a time
    leaveCurrentEvent(socket);

    const event: Event = {
      code: data.eventCode,
      name: data.eventName,
      users: new Map(),
      sessions: new Map(),
      createdAt: Date.now(),
      // only the creator gets this, and end-event must send it back
      creatorToken: randomUUID(),
      expiryTimer: setTimeout(
        () => endEvent(data.eventCode, "expired"),
        EVENT_EXPIRE_TIME,
      ),
    };
    events.set(event.code, event);

    socket.emit("event-created", {
      eventCode: event.code,
      creatorToken: event.creatorToken,
    });
    addUserToEvent(socket, event, data);
  });

  socket.on("join-event", (payload: unknown) => {
    // guessing codes over the socket shares the lookup limit: once an address
    // is over it, every join looks like a miss, so a guesser learns nothing
    const address = clientAddress(socket);
    if (isOverLimit(address)) {
      socket.emit("event-not-found");
      return;
    }

    const data = parseJoinEvent(payload);
    const event = data ? events.get(data.eventCode) : undefined;
    if (!data || !event) {
      isRateLimited(address);
      socket.emit("event-not-found");
      return;
    }

    // every update goes to everyone else, so big events get expensive fast
    if (
      event.users.size >= MAX_USERS_PER_EVENT &&
      !findMemberId(socket, event, data.sessionKey)
    ) {
      socket.emit("event-full");
      return;
    }

    // one connection belongs to one event at a time
    if (socket.data.eventCode !== event.code) leaveCurrentEvent(socket);

    addUserToEvent(socket, event, data);
  });

  socket.on("location-update", (payload: unknown) => {
    const data = parseLocationUpdate(payload);
    if (!data) return;
    const { eventCode, latitude, longitude } = data;

    const event = events.get(eventCode);
    if (!event) return;

    if (socket.data.eventCode !== eventCode) return;
    const user = event.users.get(socket.data.userId);
    if (!user) return;

    // drop updates that arrive faster than the app ever sends them
    const now = Date.now();
    const lastUpdate: number = socket.data.lastLocationUpdate ?? 0;
    if (now - lastUpdate < MIN_LOCATION_UPDATE_INTERVAL_MS) return;
    socket.data.lastLocationUpdate = now;

    user.latitude = latitude;
    user.longitude = longitude;

    socket.to(eventCode).emit("user-moved", {
      id: user.id,
      latitude,
      longitude,
    });
  });

  // leaving on purpose is announced straight away, with no grace period
  socket.on("leave-event", () => {
    console.log(`[leave-event] from event:`, socket.data.eventCode);
    leaveCurrentEvent(socket);
  });

  socket.on("end-event", (payload: unknown) => {
    const data = parseEndEvent(payload);
    if (!data) return;

    const event = events.get(data.eventCode);
    if (!event || event.creatorToken !== data.creatorToken) return;

    endEvent(data.eventCode, "ended by creator");
  });

  socket.on("disconnecting", () => {
    const event = events.get(socket.data.eventCode);
    const userId: string | undefined = socket.data.userId;
    const sessionKey: string | undefined = socket.data.sessionKey;
    if (!event || !userId || !sessionKey) return;

    const session = event.sessions.get(sessionKey);
    // a newer connection has already taken this person over
    if (!session || session.socketId !== socket.id) return;

    // wait before announcing it, a refresh or a network blip comes straight back
    session.removalTimer = setTimeout(
      () => removeUser(event, userId),
      REJOIN_GRACE_MS,
    );
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

app.get('/event/:code', (req, res) => {
  if (isRateLimited(req.ip ?? 'unknown')) {
    res.status(429).json({ error: 'Too many requests. Please try again in a minute.' });
    return;
  }

  const event = events.get(req.params.code);
  if (!event) {
    res.json({ exists: false, count: 0, name: '', createdAt: null });
    return;
  }
  res.json({
    exists: true,
    count: event.users.size,
    name: event.name,
    createdAt: event.createdAt,
    expiresAt: event.createdAt + EVENT_EXPIRE_TIME,
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
