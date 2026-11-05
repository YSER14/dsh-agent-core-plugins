/** Demo tool: count a file type under a directory (recursive). Exercises arguments + node:fs. */
import { readdir } from 'node:fs/promises'
import { join, extname } from 'node:path'

export default {
  name: 'count_files',
  description: '统计某个目录（递归）下指定扩展名的文件数量。',
  inputSchema: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '要统计的目录路径' },
      ext: { type: 'string', description: '扩展名，如 .js；默认统计全部文件' },
    },
    required: ['dir'],
  },
  async execute({ dir, ext }) {
    let count = 0
    const suffix = ext ? (ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`) : null
    const walk = async current => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (!suffix || extname(entry.name).toLowerCase() === suffix) count += 1
      }
    }
    await walk(dir)
    return `${dir} 下共有 ${count} 个${suffix ?? ''}文件`
  },
}
