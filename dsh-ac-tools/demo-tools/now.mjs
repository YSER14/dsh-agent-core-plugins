/** Demo tool: return the current time. Drop-in example of the tool file format. */
export default {
  name: 'now',
  description: '返回当前时间（ISO 8601 格式）。',
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    return new Date().toISOString()
  },
}
