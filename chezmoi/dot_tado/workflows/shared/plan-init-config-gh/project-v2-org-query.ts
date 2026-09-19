export function projectV2OrgQuery(): string {
  return `
    query($login: String!, $number: Int!) {
      organization(login: $login) {
        projectV2(number: $number) {
          id
          number
          title
          owner { __typename ... on User { login } ... on Organization { login } }
          fields(first: 50) {
            nodes {
              __typename
              ... on ProjectV2Field { id name dataType }
              ... on ProjectV2SingleSelectField { id name options { id name } }
              ... on ProjectV2IterationField { id name }
            }
          }
        }
      }
    }
  `;
}
