import type { ProjectV2 } from "./types";
import type { InitConfigOptions, InitConfigResultFull } from "./types";
import { buildConfig } from "./build-config";
import { defaultConfigPath } from "./default-config-path";
import { saveConfig } from "./save-config";

async function defaultFetchProject(owner: string, projectNumber: number): Promise<ProjectV2> {
  const { fetchProject } = await import("../plan-init-config-gh/fetch-project");
  return fetchProject(owner, projectNumber);
}

export async function initConfig(options: InitConfigOptions): Promise<InitConfigResultFull> {
  const fetch = options.fetchProject ?? defaultFetchProject;
  const project = await fetch(options.owner, options.projectNumber);
  const config = buildConfig(project, {
    statusFieldName: options.statusFieldName,
  });
  const configPath = options.configPath ?? defaultConfigPath();
  saveConfig(config, configPath);
  return { config, configPath, project };
}
