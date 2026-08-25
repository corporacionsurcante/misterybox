import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
    } & DefaultSession['user'];
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    uid?: string;
  }
}

// El rol NO viaja en la sesión ni en el JWT: se lee de la base en cada request
// privilegiado (src/lib/auth.ts). Ver el comentario de currentUser().

export {};
