/**
 * An environment variable, or undefined if unset. Claude Desktop passes the literal `${user_config.x}` placeholder for
 * optional extension settings the user left empty, so those count as unset too.
 */
export const env = (name: string, source: NodeJS.ProcessEnv = process.env): string | undefined => {
  const value = source[name];
  return value && !/^\$\{user_config\.\w+\}$/.test(value) ? value : undefined;
};
