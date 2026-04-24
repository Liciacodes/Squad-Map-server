import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
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
}

interface JoinEventPayload {
  eventCode: string;
  eventName: string | null;
  userName: string;
  latitude: number;
  longitude: number;
}

interface LocationUpdatePayload {
  eventCode: string;
  latitude: number;
  longitude: number;
}

const events = new Map<string, Event>();
const EVENT_EXPIRE_TIME = 1000 * 60 * 60;

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on(
    "join-event",
    ({
      eventCode,
      eventName,
      userName,
      latitude,
      longitude,
    }: JoinEventPayload) => {
      if (!events.has(eventCode) && (!eventName || eventName.trim() === "")) {
        socket.emit("event-not-found");
        return;
      }

      if (!events.has(eventCode)) {
        events.set(eventCode, {
          code: eventCode,
          name: eventName!,
          users: new Map(),
        });

        setTimeout(() => {
          if (events.has(eventCode)) {
            events.delete(eventCode);
            console.log(`Event ${eventCode} expired`);
          }
        }, EVENT_EXPIRE_TIME);
      }

      const event = events.get(eventCode)!;

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

      socket.join(eventCode);
      (socket as any).currentEventCode = eventCode;

      socket.emit("event-users", {
        eventName: event.name,
        users: Array.from(event.users.values()),
      });

      socket.to(eventCode).emit("user-joined", {
        id: socket.id,
        name: userName,
        latitude,
        longitude,
      });

      console.log(`${userName} joined event ${eventCode}`);
    },
  );

  socket.on(
    "location-update",
    ({ eventCode, latitude, longitude }: LocationUpdatePayload) => {
      const event = events.get(eventCode);
      if (!event) return;

      const user = event.users.get(socket.id);
      if (!user) return;

      user.latitude = latitude;
      user.longitude = longitude;

      socket.to(eventCode).emit("user-moved", {
        id: socket.id,
        latitude,
        longitude,
      });
    },
  );

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

  socket.on("end-event", ({ eventCode }: { eventCode: string }) => {
    io.to(eventCode).emit("event-ended");
    events.delete(eventCode);
    console.log(`Event ${eventCode} ended by creator`);
  });

  socket.on("disconnecting", () => {
    for (const room of socket.rooms) {
      const event = events.get(room);
      if (!event) continue;
      event.users.delete(socket.id);
      const user = event.users.get(socket.id);
      const userName = user ? user.name : "Someone";
      event.users.delete(socket.id);

      socket.to(room).emit("user-left", socket.id,userName);
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

httpServer.listen(3001, () => {
  console.log("Server running on port 3001");
});
