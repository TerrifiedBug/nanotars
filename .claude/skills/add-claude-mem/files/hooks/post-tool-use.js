// Claude-mem auto-capture: save tool use observations to the worker API.
// Loaded by agent-runner as a plugin container hook when CLAUDE_MEM_URL is set.

export function register(ctx) {
  const url = ctx.env.CLAUDE_MEM_URL;
  if (!url) return {};

  return {
    PostToolUse: [{
      hooks: [async (input) => {
        const inputStr = typeof input.tool_input === 'string'
          ? input.tool_input
          : JSON.stringify(input.tool_input);
        const responseStr = typeof input.tool_response === 'string'
          ? input.tool_response
          : JSON.stringify(input.tool_response);
        const text = `[${ctx.groupFolder}] Tool: ${input.tool_name}\nInput: ${inputStr.slice(0, 500)}\nOutput: ${responseStr.slice(0, 2000)}`;

        fetch(`${url}/api/memory/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            title: `${input.tool_name} (${ctx.groupFolder})`,
            project: `nanoclaw-${ctx.groupFolder || 'main'}`,
          }),
        }).catch(() => {});

        return {};
      }],
    }],
  };
}
