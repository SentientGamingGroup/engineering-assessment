// Entry point loaded by index.html. The client itself is TypeScript (start at
// Game.ts); the gateway serves client/*.ts with types stripped by Node's built-in
// stripTypeScriptTypes, so there is no build step.
import { Game } from './Game.ts';

new Game(document).start();
