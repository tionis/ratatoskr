import { z } from "zod";

const configSchema = z.object({
  port: z.coerce.number().default(4151),
  host: z.string().default("0.0.0.0"),
  baseUrl: z.string().url(),
  dataDir: z.string().default("./data"),

  // OIDC
  oidc: z.object({
    issuer: z.string().url(),
    clientId: z.string(),
    clientSecret: z.string().optional(),
    redirectUri: z.string().url(),
  }),

  // Quotas (defaults)
  quotas: z.object({
    maxDocuments: z.coerce.number().default(10_000),
    maxDocumentSize: z.coerce.number().default(10 * 1024 * 1024), // 10 MB
    maxTotalStorage: z.coerce.number().default(1024 * 1024 * 1024), // 1 GB
  }),

  // Rate limits
  rateLimits: z.object({
    anon: z.object({
      connectionsPerMinute: z.coerce.number().default(5),
      messagesPerMinute: z.coerce.number().default(100),
      ephemeralPerHour: z.coerce.number().default(10),
    }),
    auth: z.object({
      connectionsPerMinute: z.coerce.number().default(100),
      documentsPerHour: z.coerce.number().default(1000),
    }),
  }),

  // Ephemeral documents
  ephemeralTimeoutSeconds: z.coerce.number().default(300),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const env = process.env;

  return configSchema.parse({
    port: env.PORT,
    host: env.HOST,
    baseUrl: env.BASE_URL,
    dataDir: env.DATA_DIR,

    oidc: {
      issuer: env.OIDC_ISSUER,
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
      redirectUri: env.OIDC_REDIRECT_URI,
    },

    quotas: {
      maxDocuments: env.DEFAULT_MAX_DOCUMENTS,
      maxDocumentSize: env.DEFAULT_MAX_DOCUMENT_SIZE,
      maxTotalStorage: env.DEFAULT_MAX_TOTAL_STORAGE,
    },

    rateLimits: {
      anon: {
        connectionsPerMinute: env.ANON_RATE_LIMIT_CONNECTIONS,
        messagesPerMinute: env.ANON_RATE_LIMIT_MESSAGES,
        ephemeralPerHour: env.ANON_RATE_LIMIT_EPHEMERAL,
      },
      auth: {
        connectionsPerMinute: env.AUTH_RATE_LIMIT_CONNECTIONS,
        documentsPerHour: env.AUTH_RATE_LIMIT_DOCUMENTS,
      },
    },

    ephemeralTimeoutSeconds: env.EPHEMERAL_TIMEOUT_SECONDS,
  });
}

export const config = loadConfig();
