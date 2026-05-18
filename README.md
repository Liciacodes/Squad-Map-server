# SquadMap Server

Real-time WebSocket backend for [SquadMap](https://squad-map-kappa.vercel.app) — 
a location sharing app that lets friends find each other at events in real time.

## What it does

- Manages real-time socket rooms per event
- Broadcasts live location updates between squad members
- Handles event creation, joining, leaving and expiry
- REST endpoint to check event info before joining

## Tech Stack

- Node.js + TypeScript
- Express
- Socket.io
- Deployed on Render

## Socket Events

| Event | Direction | Description |
|---|---|---|
| `join-event` | Client → Server | Join or create an event |
| `leave-event` | Client → Server | Leave an event |
| `end-event` | Client → Server | End event (creator only) |
| `location-update` | Client → Server | Broadcast new coordinates |
| `event-users` | Server → Client | List of users in event |
| `user-joined` | Server → Client | New user joined |
| `user-left` | Server → Client | User left |
| `user-moved` | Server → Client | User location updated |
| `event-ended` | Server → Client | Event ended or expired |
| `event-not-found` | Server → Client | Invalid event code |

## REST Endpoints

GET /event/:code

Returns event info before joining:

```json
{
  "exists": true,
  "count": 3,
  "name": "Lagos Fitness Fest",
  "createdAt": 1234567890
}
```

## Run Locally

```bash
npm install
npm run dev
```

Server runs on `http://localhost:3001`

## Related

- [SquadMap Frontend](https://github.com/Liciacodes/Squad-Map)
- [Live App](https://squad-map-kappa.vercel.app)
