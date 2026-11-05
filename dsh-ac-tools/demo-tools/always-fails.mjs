/** Demo tool: throws. Used to prove tool failures become normal error results. */
export default {
  name: 'always_fails',
  description: '抛错测试工具：错误应变成一条正常工具结果。',
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    throw new Error('故意抛出的错误，用于测试')
  },
}
