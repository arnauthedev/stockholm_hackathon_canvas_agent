// Offline reset (runner not running): node --import tsx runner/src/reset-cli.ts
import { moveStateToBackup } from "./reset.ts";
console.log(`state moved to agent-home/${await moveStateToBackup()}`);
process.exit(0);
