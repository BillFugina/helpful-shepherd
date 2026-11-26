import { handleMcp } from '../server/mcp.js'

// The Claude connector's endpoint. GET and DELETE answer 405 (stateless server).
export const GET = handleMcp
export const POST = handleMcp
export const DELETE = handleMcp
