import { runCommand } from "../plan-init-config-gh/run-command";
import { GitCommandError } from "../plan-init-config-gh/git-command-error";
import { TransitionPlanError } from "./transition-plan-error";

export async function defaultUpdateItemStatus(params: {
  projectId: string;
  itemId: string;
  fieldId: string;
  optionId: string;
}): Promise<void> {
  const mutation = `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }) {
        projectV2Item { id }
      }
    }
  `;

  const args = [
    "api",
    "graphql",
    "-H",
    "GraphQL-Features: project_v2",
    "-f",
    `query=${mutation}`,
    "-f",
    `projectId=${params.projectId}`,
    "-f",
    `itemId=${params.itemId}`,
    "-f",
    `fieldId=${params.fieldId}`,
    "-f",
    `optionId=${params.optionId}`,
  ];

  try {
    await runCommand("gh", args);
  } catch (error) {
    if (error instanceof GitCommandError) {
      throw new TransitionPlanError(error.message);
    }
    throw error;
  }
}
