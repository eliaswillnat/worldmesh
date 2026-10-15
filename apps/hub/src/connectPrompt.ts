/**
 * The prompt creators paste into their own AI coding agent to connect a world
 * (the homepage's "Connect your world" section). /creators shows the same
 * text; test/connectPrompt.test.ts keeps the two in step. The details live in
 * /connect.md, so this stays short.
 */
export const CONNECT_PROMPT = `Connect this 3D world to WorldMesh (https://worldmesh.net).

Work in this project as it is on my computer. You do not need GitHub access, a pull request or a WorldMesh account.

1. Read the official guide at https://worldmesh.net/connect.md and follow it step by step. If you cannot open web pages, tell me and I will paste the guide in.
2. Inspect the project first: engine, render loop, controls, player, physics, any existing multiplayer, and how it is deployed.
3. Keep my existing gameplay, controls, rendering and multiplayer working. Ask me before removing or replacing any of them.
4. Do not use the multiplayer relay WorldMesh hosts. Use my existing multiplayer, or set up a WorldMesh relay on my own hosting as the guide explains.
5. Ask me before creating accounts, adding paid services, deploying, or committing and pushing.
6. When you are done, tell me plainly what works, what you tested, and what is still left for me to do. Do not say it is finished if it is not.`;
