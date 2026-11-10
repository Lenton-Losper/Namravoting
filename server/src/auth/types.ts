export interface AuthUser {
  oid: string;          // Entra object id (uuid)
  email: string;
  displayName: string;
  roles: string[];      // e.g. ["CampaignAdmin"]
}
export const ADMIN_ROLE = 'CampaignAdmin';
