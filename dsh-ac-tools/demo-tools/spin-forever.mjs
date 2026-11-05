/** Demo tool: infinite loop. Used to prove the timeout kills the subprocess without harming the harness. */
export default {
  name: 'spin_forever',
  description: '死循环测试工具：证明超时能杀死子进程。',
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    let i = 0
    while (true) { i += 1 }
  },
}
