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

interface Event {
  code: string;
  name: string;
  users: Map<string, User>;
  createdAt: number;
  creatorToken: string;
  expiryTimer: NodeJS.Timeout;
}

interface JoinEventPayload {
  eventCode: string;
  userName: string;
  latitude: number;
  longitude: number;
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
  const { userName } = payload;
  if (!isName(userName, MAX_USER_NAME_LENGTH)) return null;
  return { ...location, userName: userName.trim() };
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

function addUserToEvent(
  socket: Socket,
  event: Event,
  { userName, latitude, longitude }: JoinEventPayload,
) {
  if (event.users.has(socket.id)) {
    socket.emit("event-users", {
      eventName: event.name,
      users: Array.from(event.users.values()),
    });
    return;
  }

  event.users.set(socket.id, {
    id: socket.id,
    name: userName,
    latitude,
    longitude,
  });

  socket.join(event.code);
  (socket as any).currentEventCode = event.code;

  socket.emit("event-users", {
    eventName: event.name,
    createdAt: event.createdAt,
    users: Array.from(event.users.values()),
  });

  socket.to(event.code).emit("user-joined", {
    id: socket.id,
    name: userName,
    latitude,
    longitude,
  });

  console.log(`${userName} joined event ${event.code}`);
}

function endEvent(eventCode: string, reason: string) {
  const event = events.get(eventCode);
  if (!event) return;

  clearTimeout(event.expiryTimer);
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

    const event: Event = {
      code: data.eventCode,
      name: data.eventName,
      users: new Map(),
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
    const data = parseJoinEvent(payload);
    const event = data ? events.get(data.eventCode) : undefined;
    if (!data || !event) {
      socket.emit("event-not-found");
      return;
    }

    // every update goes to everyone else, so big events get expensive fast
    if (
      event.users.size >= MAX_USERS_PER_EVENT &&
      !event.users.has(socket.id)
    ) {
      socket.emit("event-full");
      return;
    }

    addUserToEvent(socket, event, data);
  });

  socket.on("location-update", (payload: unknown) => {
    const data = parseLocationUpdate(payload);
    if (!data) return;
    const { eventCode, latitude, longitude } = data;

    const event = events.get(eventCode);
    if (!event) return;

    const user = event.users.get(socket.id);
    if (!user) return;

    // drop updates that arrive faster than the app ever sends them
    const now = Date.now();
    const lastUpdate: number = socket.data.lastLocationUpdate ?? 0;
    if (now - lastUpdate < MIN_LOCATION_UPDATE_INTERVAL_MS) return;
    socket.data.lastLocationUpdate = now;

    user.latitude = latitude;
    user.longitude = longitude;

    socket.to(eventCode).emit("user-moved", {
      id: socket.id,
      latitude,
      longitude,
    });
  });

  socket.on("leave-event", () => {
    let eventCode: string | null = null;

    for (const room of socket.rooms) {
      if (events.has(room)) {
        eventCode = room;
        break;
      }
    }

    console.log(`[leave-event] found eventCode:`, eventCode);

    if (!eventCode) return;

    const event = events.get(eventCode);
    if (!event) return;
    const user = event.users.get(socket.id);


    event.users.delete(socket.id);
    const userName = user ? user.name : "Unknown";
    socket.leave(eventCode);
    delete (socket as any).currentEventCode;

    console.log(
      `[leave-event] emitting user-left to room ${eventCode}, remaining users: ${event.users.size}`,
    );
    io.to(eventCode).emit("user-left", socket.id, userName);
  });

  socket.on("end-event", (payload: unknown) => {
    const data = parseEndEvent(payload);
    if (!data) return;

    const event = events.get(data.eventCode);
    if (!event || event.creatorToken !== data.creatorToken) return;

    endEvent(data.eventCode, "ended by creator");
  });

  // socket.on("disconnecting", () => {
  //   for (const room of socket.rooms) {
  //     const event = events.get(room);
  //     if (!event) continue;
  //     event.users.delete(socket.id);
  //     const user = event.users.get(socket.id);
  //     const userName = user ? user.name : "Someone";
  //     event.users.delete(socket.id);
  //     if(event.creatorId === socket.id) {
  //       io.to(room).emit("event-ended");
  //       events.delete(room);
  //       console.log(`Event ${room} ended due to creator disconnect`);

  //     } else {
  //        socket.to(room).emit("user-left", socket.id,userName);
  //     }


  //   }
  // });

  socket.on("disconnecting", () => {
  for (const room of socket.rooms) {
    const event = events.get(room);
    if (!event) continue;

    const user = event.users.get(socket.id)
    const userName = user ? user.name : "Someone"

    event.users.delete(socket.id);


    socket.to(room).emit("user-left", socket.id, userName);
  }
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
  res.json({ exists: true, count: event.users.size, name: event.name, createdAt: event.createdAt });
});

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
