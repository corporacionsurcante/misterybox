import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@/lib/prisma';
import { UserRole, UserStatus } from '@/generated/prisma/client';

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: PrismaAdapter(prisma) as never,
  session: {
    strategy: 'jwt',
    // 7 días en vez de los 30 por defecto: acota la ventana en la que un token
    // viejo sigue siendo válido. Igual, los permisos se releen de la base en
    // cada request privilegiado (ver requireAdmin más abajo).
    maxAge: 7 * 24 * 60 * 60,
  },
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      allowDangerousEmailAccountLinking: true,
    }),
  ],
  pages: { signIn: '/login' },
  callbacks: {
    async jwt({ token, user }) {
      if (user?.id) token.uid = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user) session.user.id = token.uid as string;
      return session;
    },
  },
});

/**
 * Usuario autenticado, con rol y estado LEÍDOS DE LA BASE.
 *
 * El rol NO se guarda en el JWT a propósito. Si viviera en el token, degradar
 * a un admin o suspender a un usuario por fraude no tendría efecto hasta que
 * su sesión expirara: seguiría entrando con los permisos viejos durante días.
 * Este viaje extra a la base es lo que hace que revocar permisos sea inmediato.
 */
export async function currentUser() {
  const session = await auth();
  if (!session?.user?.id) return null;

  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, email: true, name: true, role: true, status: true },
  });

  if (!dbUser) return null;
  if (dbUser.status !== UserStatus.ACTIVE) return null;

  return dbUser;
}

/** Devuelve el usuario sólo si es ADMIN. Cualquier otro rol → null. */
export async function requireAdmin() {
  const user = await currentUser();
  if (!user || user.role !== UserRole.ADMIN) return null;
  return user;
}

/**
 * Para tareas operativas de menor privilegio (revisión de comprobantes OCR).
 * NO habilita el gestor de premios ni los feature flags: un moderador que
 * pudiera editar `realCost` y `baseWeight` podría fabricarse premios y
 * vaciarse el pool a su propia billetera.
 */
export async function requireModerator() {
  const user = await currentUser();
  if (!user) return null;
  if (user.role !== UserRole.ADMIN && user.role !== UserRole.MODERATOR) return null;
  return user;
}

/** Personal de puerta para escanear entradas. */
export async function requireStaff() {
  const user = await currentUser();
  if (!user) return null;
  if (user.role === UserRole.USER) return null;
  return user;
}
