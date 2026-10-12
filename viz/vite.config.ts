import { defineConfig } from 'vite'

// fs.allow: replay serves trace files from the repo (?trace=/@fs/<repo>/traces/<session>.jsonl).
export default defineConfig({ esbuild: { jsx: 'automatic' }, server: { port: 5288, fs: { allow: ['..'] } } })
