export function buildFindItemQuery(): string {
  return `
    query($projectId: ID!, $after: String) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 100, after: $after) {
            nodes {
              id
              fieldValueByName(name: "Status") {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  optionId
                }
              }
              content {
                ... on Issue {
                  number
                  repository { nameWithOwner }
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }
  `;
}
