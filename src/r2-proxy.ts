import { WorkerEntrypoint } from 'cloudflare:workers'

export class R2Proxy extends WorkerEntrypoint<Env> {
  async get(key: string): Promise<string | null> {
    const object = await this.env.STAGING_R2.get(key)
    if (!object) return null
    return object.text()
  }

  async put(key: string, value: string): Promise<void> {
    await this.env.STAGING_R2.put(key, value)
  }

  async delete(key: string): Promise<void> {
    await this.env.STAGING_R2.delete(key)
  }
}
