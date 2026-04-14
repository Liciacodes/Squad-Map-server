import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'

const app = express()
app.use(cors())

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
})

interface User {
  id: string
  name: string
  latitude: number
  longitude: number
}

interface Event {
  code: string
  name: string
  users: Map<string, User>
}


interface JoinEventPayLoad {
    eventCode: string
    eventName: string
    userName: string
    latitude: number
    longitude: number
}

interface LocationUpdatePayload {
    eventCode: string
    latitude: number
    longitude: number
}

const events = new Map<string, Event>()

io.on('connection', (socket) => {
  console.log('User connected:', socket.id)

  socket.on('join-event', ({ eventCode, eventName, userName, latitude, longitude }: JoinEventPayLoad) => {
    // create event if it doesn't exist
    if (!events.has(eventCode)) {
      events.set(eventCode, {
        code: eventCode,
        name: eventName,
        users: new Map()
      })
    }

    const event = events.get(eventCode)!

    // add user to event
    event.users.set(socket.id, {
      id: socket.id,
      name: userName,
      latitude,
      longitude
    })

    // join socket room
    socket.join(eventCode)

    // send all current users to the new user
    const users = Array.from(event.users.values())
    socket.emit('event-users', users)

    // tell everyone else a new user joined
    socket.to(eventCode).emit('user-joined', {
      id: socket.id,
      name: userName,
      latitude,
      longitude
    })

    console.log(`${userName} joined event ${eventCode}`)
  })

  socket.on('location-update', ({ eventCode, latitude, longitude }: LocationUpdatePayload) => {
    const event = events.get(eventCode)
    if (!event) return

    const user = event.users.get(socket.id)
    if (!user) return

    // update location
    user.latitude = latitude
    user.longitude = longitude

    // broadcast to everyone else in the event
    socket.to(eventCode).emit('user-moved', {
      id: socket.id,
      latitude,
      longitude
    })
  })

  socket.on('disconnecting', () => {
    // remove user from all events they were in
    socket.rooms.forEach((room) => {
      const event = events.get(room)
      if (!event) return

      event.users.delete(socket.id)

      socket.to(room).emit('user-left', socket.id)
    })
  })

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id)
  })
})

httpServer.listen(3001, () => {
  console.log('Server running on port 3001')
})