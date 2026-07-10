import Google from "@auth/core/providers/google";
import { convexAuth } from "@convex-dev/auth/server";

// Google OAuth redirect URI (configure in Google Cloud Console):
// https://<deployment>.convex.site/api/auth/callback/google
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Google],
});
