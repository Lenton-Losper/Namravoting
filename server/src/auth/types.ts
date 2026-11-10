export interface AuthUser {
  oid: string;          // Entra object id (uuid)
  email: string;
  displayName: string;
  roles: string[];      // e.g. ["CampaignAdmin"]
  employeeCode: string | null;   // NamRA employee code (e.g. TST0445). Entra: the employeeId attribute. Never derived from the email.
}
export const ADMIN_ROLE = 'CampaignAdmin';
