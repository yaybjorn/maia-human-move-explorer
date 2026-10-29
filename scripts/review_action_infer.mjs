// Invoke the documented tool-free CLI without placing private prompt text in OS argv.
let prompt='';
for await (const chunk of process.stdin) {
  prompt += chunk;
  if (prompt.length > 150000) throw new Error('Input too large');
}
if (!prompt.trim()) throw new Error('Empty prompt');
process.argv=[process.execPath,'/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs','infer','model','run','--local','--agent','odin','--model','openai/gpt-5.6-luna','--prompt',prompt,'--json'];
await import('/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs');
