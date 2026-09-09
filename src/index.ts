import cors from 'cors'
import express, { type Request, type Response } from 'express'

const app = express()
const PORT = Number(process.env.PORT) || 3000

app.use(cors())
app.use(express.json())

app.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'Express + TypeScript server is running' })
})

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  })
})

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`)
})
