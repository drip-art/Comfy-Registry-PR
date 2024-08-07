import { mongoClient } from "@/src/db";
import { MongoDBAdapter } from "@auth/mongodb-adapter";
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import Nodemailer from "next-auth/providers/nodemailer";
import "nodemailer";
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: MongoDBAdapter(Promise.resolve(mongoClient)),
  providers: [
    ...(process.env.AUTH_EMAIL_SERVER
      ? [
          Nodemailer({
            name: "Email Magic Link",
            server: process.env.AUTH_EMAIL_SERVER,
            from: process.env.AUTH_EMAIL_FROM,
          }),
        ]
      : []),
    ...(process.env.AUTH_GITHUB_SECRET ? [GitHub] : []),
    ...(process.env.AUTH_GOOGLE_SECRET ? [Google] : []),
  ],
});
