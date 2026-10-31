import { OAuth2Client } from 'google-auth-library';
import { AppError, invalidCredentials } from '@livechat/shared';
import { config } from './config.js';

const client = new OAuth2Client();

export interface GoogleIdentity {
  subject: string;
  email: string;
  name: string | null;
}

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  if (config.googleOAuthClientIds.length === 0) {
    throw new AppError('internal_error', 'Google sign-in is not configured on this server.', 503);
  }

  let payload;
  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: config.googleOAuthClientIds,
    });
    payload = ticket.getPayload();
  } catch {
    throw invalidCredentials('The Google sign-in credential is invalid or expired.');
  }

  if (!payload?.sub || !payload.email || payload.email_verified !== true) {
    throw invalidCredentials('Google must provide a verified email address.');
  }

  return {
    subject: payload.sub,
    email: payload.email.trim().toLowerCase(),
    name: payload.name?.trim().slice(0, 100) || null,
  };
}
