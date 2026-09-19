export type GhProjectViewResponse = {
  data?: {
    user?: { projectV2: RawProjectV2 | null } | null;
    organization?: { projectV2: RawProjectV2 | null } | null;
  };
  errors?: Array<{ message: string }>;
};

export type RawProjectV2 = {
  id: string;
  number: number;
  title: string;
  owner: { __typename: "User" | "Organization"; login: string };
  fields: {
    nodes: Array<{
      __typename?: string;
      id: string;
      name: string;
      dataType?: string;
      options?: Array<{ id: string; name: string }> | null;
    }>;
  };
};
