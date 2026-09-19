export function projectV2UserQuery(): string {
  return `
    query($login: String!, $number: Int!) {
      user(login: $login) {
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
