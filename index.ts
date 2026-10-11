import { PTYPlugin } from './src/plugin.ts'
import { PTYPluginV2 } from './src/plugin/v2.ts'

// OpenCode >=1.18.29 calls server(); OpenCode 2 calls setup().
export default { ...PTYPluginV2, server: PTYPlugin }
