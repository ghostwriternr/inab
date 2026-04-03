export { GlobalOutbound } from './global-outbound'

export default {
  async fetch(): Promise<Response> {
    return new Response('ynab-mcp')
  },
}
