import type { ProjectV2, ProjectV2Field, ProjectV2Owner } from "../plan-init-config/types";
import type { RawProjectV2 } from "./types";

export function mapProject(raw: RawProjectV2): ProjectV2 {
  const fields: ProjectV2Field[] = raw.fields.nodes.map((node) => ({
    id: node.id,
    name: node.name,
    dataType: node.dataType,
    options: node.options ?? undefined,
  }));

  const owner: ProjectV2Owner = {
    __typename: raw.owner.__typename,
    login: raw.owner.login,
  };

  return {
    id: raw.id,
    number: raw.number,
    title: raw.title,
    owner,
    fields: { nodes: fields },
  };
}
