import { config } from "dotenv";
import { resolve } from "node:path";

/**
 * Loads the environment contract shared by production pipeline CLIs.
 *
 * Preserve shell values, let `.env.local` override `.env`, then use code
 * defaults where neither file nor shell supplies a setting.
 * This must run before a CLI reads environment-derived arguments or invokes
 * processing code; runtime configuration itself is resolved at call time.
 */
export function loadPipelineEnvironment(
  options: { cwd?: string; environment?: NodeJS.ProcessEnv } = {},
): void {
  const cwd = options.cwd ?? process.cwd();
  const environment = options.environment ?? process.env;
  const shellEnvironment = { ...environment };

  // dotenv's default behavior fills only absent values, so shell values win
  // over `.env`. Parse `.env.local` separately, then selectively apply it to
  // replace `.env` values without replacing values supplied by the shell.
  config({ path: resolve(cwd, ".env"), processEnv: environment });
  const localEnvironment = {} as NodeJS.ProcessEnv;
  config({ path: resolve(cwd, ".env.local"), processEnv: localEnvironment });
  for (const [key, value] of Object.entries(localEnvironment)) {
    if (!(key in shellEnvironment)) environment[key] = value;
  }
}
