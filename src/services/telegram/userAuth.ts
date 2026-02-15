import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config/index.js';

const dynamicImport = new Function(
  'modulePath',
  'return import(modulePath)',
) as (modulePath: string) => Promise<unknown>;

const USER_TELEGRAM_AUTH_STATUS = {
  PENDING_CODE: 'PENDING_CODE',
  PENDING_PASSWORD: 'PENDING_PASSWORD',
  AUTHORIZED: 'AUTHORIZED',
  FAILED: 'FAILED',
  DISCONNECTED: 'DISCONNECTED',
} as const;

export type UserTelegramSessionState =
  | 'NOT_CONNECTED'
  | typeof USER_TELEGRAM_AUTH_STATUS.PENDING_CODE
  | typeof USER_TELEGRAM_AUTH_STATUS.PENDING_PASSWORD
  | typeof USER_TELEGRAM_AUTH_STATUS.AUTHORIZED
  | typeof USER_TELEGRAM_AUTH_STATUS.FAILED
  | typeof USER_TELEGRAM_AUTH_STATUS.DISCONNECTED;

export interface UserTelegramStatusPayload {
  enabled: boolean;
  status: UserTelegramSessionState;
  isAuthorized: boolean;
  phoneNumberMasked: string | null;
  lastAuthorizedAt: Date | null;
  lastError: string | null;
  updatedAt: Date | null;
}

interface EncryptedPayload {
  iv: string;
  tag: string;
  data: string;
  v: number;
}

interface StoredAuthState {
  phoneCodeHash?: string;
  requestedAt?: string;
}

interface GramJsRuntime {
  TelegramClient: new (...args: any[]) => any;
  StringSession: new (session: string) => any;
  Api: Record<string, any>;
  computeCheck?: (passwordData: unknown, password: string) => Promise<unknown>;
}

function ensureMtprotoEnabled(): void {
  if (!config.mtprotoEnabled) {
    throw new Error('Telegram API credentials are not configured on backend.');
  }
}

function normalizePhoneNumber(input: string): string {
  const compact = input.replace(/[^\d+]/g, '');
  const normalized = compact.startsWith('+') ? compact : `+${compact}`;

  if (!/^\+\d{7,15}$/.test(normalized)) {
    throw new Error('Invalid phone number format. Use international format, e.g. +1234567890.');
  }

  return normalized;
}

function maskPhoneNumber(phoneNumber: string): string {
  if (phoneNumber.length <= 6) {
    return phoneNumber;
  }

  return `${phoneNumber.slice(0, 3)}***${phoneNumber.slice(-2)}`;
}

function parseTelegramError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Unknown Telegram authorization error';
}

function isPasswordNeededError(error: unknown): boolean {
  return parseTelegramError(error).toUpperCase().includes('SESSION_PASSWORD_NEEDED');
}

function isInvalidCodeError(error: unknown): boolean {
  const message = parseTelegramError(error).toUpperCase();
  return (
    message.includes('PHONE_CODE_INVALID') ||
    message.includes('PHONE_CODE_EXPIRED') ||
    message.includes('CODE_INVALID')
  );
}

function getEncryptionKey(): Buffer {
  if (!config.mtprotoSessionEncryptionKey) {
    throw new Error('MTPROTO_SESSION_ENCRYPTION_KEY is not configured.');
  }

  return createHash('sha256').update(config.mtprotoSessionEncryptionKey).digest();
}

function encryptString(value: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const payload: EncryptedPayload = {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
    v: 1,
  };

  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function decryptString(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const decoded = Buffer.from(value, 'base64').toString('utf8');
  const payload = JSON.parse(decoded) as EncryptedPayload;
  if (payload.v !== 1) {
    throw new Error('Unsupported encrypted payload version.');
  }

  const key = getEncryptionKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

function parseAuthState(value: string | null): StoredAuthState {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as StoredAuthState;
    return parsed ?? {};
  } catch {
    return {};
  }
}

async function loadGramJs(): Promise<GramJsRuntime> {
  let telegramModule: any;
  try {
    telegramModule = await dynamicImport('telegram');
  } catch {
    throw new Error(
      'MTProto library "telegram" is not installed. Run `npm install telegram --workspace=backend`.',
    );
  }

  let sessionsModule: any;
  try {
    sessionsModule = await dynamicImport('telegram/sessions/index.js');
  } catch {
    sessionsModule = await dynamicImport('telegram/sessions');
  }

  let passwordModule: any = null;
  try {
    passwordModule = await dynamicImport('telegram/Password');
  } catch {
    passwordModule = null;
  }

  const TelegramClient = telegramModule.TelegramClient || telegramModule.default?.TelegramClient;
  const Api = telegramModule.Api || telegramModule.default?.Api;
  const StringSession = sessionsModule.StringSession || sessionsModule.default?.StringSession;
  const computeCheck =
    passwordModule?.computeCheck || passwordModule?.default?.computeCheck || undefined;

  if (!TelegramClient || !Api || !StringSession) {
    throw new Error('Failed to initialize MTProto runtime.');
  }

  return { TelegramClient, StringSession, Api, computeCheck };
}

async function createMtprotoClient(serializedSession: string) {
  ensureMtprotoEnabled();
  const runtime = await loadGramJs();
  const session = new runtime.StringSession(serializedSession);
  const client = new runtime.TelegramClient(
    session,
    config.telegramApiId,
    config.telegramApiHash,
    { connectionRetries: 3 },
  );

  if (typeof client.setLogLevel === 'function') {
    client.setLogLevel('none');
  }

  await client.connect();
  return { client, runtime };
}

async function disconnectClient(client: any): Promise<void> {
  if (!client) {
    return;
  }
  try {
    if (typeof client.disconnect === 'function') {
      await client.disconnect();
    } else if (typeof client.destroy === 'function') {
      await client.destroy();
    }
  } catch {
    // Intentionally ignore disconnect errors
  }
}

function serializeSession(client: any): string {
  const value = client?.session?.save?.();
  return typeof value === 'string' ? value : '';
}

async function signInWithPassword(
  client: any,
  runtime: GramJsRuntime,
  password: string,
): Promise<void> {
  if (typeof client.checkPassword === 'function') {
    await client.checkPassword(password);
    return;
  }

  if (!runtime.computeCheck) {
    throw new Error('MTProto runtime does not support password verification.');
  }

  const passwordInfo = await client.invoke(new runtime.Api.account.GetPassword({}));
  const passwordHash = await runtime.computeCheck(passwordInfo, password);
  await client.invoke(new runtime.Api.auth.CheckPassword({ password: passwordHash }));
}

export async function getUserTelegramAuthStatus(
  userId: string,
): Promise<UserTelegramStatusPayload> {
  if (!config.mtprotoEnabled) {
    return {
      enabled: false,
      status: 'NOT_CONNECTED',
      isAuthorized: false,
      phoneNumberMasked: null,
      lastAuthorizedAt: null,
      lastError: null,
      updatedAt: null,
    };
  }

  const session = await prisma.userTelegramSession.findUnique({
    where: { userId },
  });

  if (!session) {
    return {
      enabled: true,
      status: 'NOT_CONNECTED',
      isAuthorized: false,
      phoneNumberMasked: null,
      lastAuthorizedAt: null,
      lastError: null,
      updatedAt: null,
    };
  }

  return {
    enabled: true,
    status: session.status as UserTelegramSessionState,
    isAuthorized: session.status === USER_TELEGRAM_AUTH_STATUS.AUTHORIZED,
    phoneNumberMasked: maskPhoneNumber(session.phoneNumber),
    lastAuthorizedAt: session.lastAuthorizedAt,
    lastError: session.lastError,
    updatedAt: session.updatedAt,
  };
}

export async function startUserTelegramAuth(params: {
  userId: string;
  phoneNumber: string;
  forceSms?: boolean;
}) {
  ensureMtprotoEnabled();
  const phoneNumber = normalizePhoneNumber(params.phoneNumber);
  const existing = await prisma.userTelegramSession.findUnique({
    where: { userId: params.userId },
  });

  let existingSessionValue = '';
  if (existing) {
    try {
      existingSessionValue = decryptString(existing.sessionEncrypted) || '';
    } catch {
      existingSessionValue = '';
    }
  }

  const { client } = await createMtprotoClient(existingSessionValue);
  try {
    const sendCodeResult = await client.sendCode(
      { apiId: config.telegramApiId, apiHash: config.telegramApiHash },
      phoneNumber,
      !!params.forceSms,
    );
    const phoneCodeHash = sendCodeResult?.phoneCodeHash || sendCodeResult?.phone_code_hash;

    if (!phoneCodeHash || typeof phoneCodeHash !== 'string') {
      throw new Error('Failed to request verification code from Telegram.');
    }

    const nextSessionValue = serializeSession(client);
    const authStateEncrypted = encryptString(
      JSON.stringify({
        phoneCodeHash,
        requestedAt: new Date().toISOString(),
      } satisfies StoredAuthState),
    );

    await prisma.userTelegramSession.upsert({
      where: { userId: params.userId },
      update: {
        status: USER_TELEGRAM_AUTH_STATUS.PENDING_CODE,
        phoneNumber,
        sessionEncrypted: encryptString(nextSessionValue),
        authStateEncrypted,
        lastError: null,
      },
      create: {
        userId: params.userId,
        status: USER_TELEGRAM_AUTH_STATUS.PENDING_CODE,
        phoneNumber,
        sessionEncrypted: encryptString(nextSessionValue),
        authStateEncrypted,
        lastError: null,
      },
    });

    return {
      status: USER_TELEGRAM_AUTH_STATUS.PENDING_CODE,
      phoneNumberMasked: maskPhoneNumber(phoneNumber),
      deliveryMethod: sendCodeResult?.isCodeViaApp ? 'TELEGRAM_APP' : 'SMS',
      forceSmsRequested: !!params.forceSms,
    };
  } catch (error) {
    const message = parseTelegramError(error);
    await prisma.userTelegramSession.upsert({
      where: { userId: params.userId },
      update: {
        status: USER_TELEGRAM_AUTH_STATUS.FAILED,
        phoneNumber,
        sessionEncrypted: encryptString(serializeSession(client)),
        authStateEncrypted: null,
        lastError: message,
      },
      create: {
        userId: params.userId,
        status: USER_TELEGRAM_AUTH_STATUS.FAILED,
        phoneNumber,
        sessionEncrypted: encryptString(serializeSession(client)),
        authStateEncrypted: null,
        lastError: message,
      },
    });
    throw new Error(message);
  } finally {
    await disconnectClient(client);
  }
}

export async function submitUserTelegramAuthCode(params: {
  userId: string;
  code: string;
}) {
  ensureMtprotoEnabled();
  const code = params.code.trim();
  if (!code) {
    throw new Error('Verification code is required.');
  }

  const session = await prisma.userTelegramSession.findUnique({
    where: { userId: params.userId },
  });

  if (!session) {
    throw new Error('Telegram session is not started.');
  }

  const authStateRaw = decryptString(session.authStateEncrypted);
  const authState = parseAuthState(authStateRaw);
  if (!authState.phoneCodeHash) {
    throw new Error('Verification state is missing. Start authentication again.');
  }

  const sessionValue = decryptString(session.sessionEncrypted) || '';
  const { client, runtime } = await createMtprotoClient(sessionValue);
  try {
    await client.invoke(
      new runtime.Api.auth.SignIn({
        phoneNumber: session.phoneNumber,
        phoneCodeHash: authState.phoneCodeHash,
        phoneCode: code,
      }),
    );

    await prisma.userTelegramSession.update({
      where: { userId: params.userId },
      data: {
        status: USER_TELEGRAM_AUTH_STATUS.AUTHORIZED,
        sessionEncrypted: encryptString(serializeSession(client)),
        authStateEncrypted: null,
        lastAuthorizedAt: new Date(),
        lastError: null,
      },
    });

    return {
      status: USER_TELEGRAM_AUTH_STATUS.AUTHORIZED,
      isAuthorized: true,
    };
  } catch (error) {
    if (isPasswordNeededError(error)) {
      await prisma.userTelegramSession.update({
        where: { userId: params.userId },
        data: {
          status: USER_TELEGRAM_AUTH_STATUS.PENDING_PASSWORD,
          sessionEncrypted: encryptString(serializeSession(client)),
          authStateEncrypted: encryptString(
            JSON.stringify({
              phoneCodeHash: authState.phoneCodeHash,
              requestedAt: authState.requestedAt,
            } satisfies StoredAuthState),
          ),
          lastError: null,
        },
      });

      return {
        status: USER_TELEGRAM_AUTH_STATUS.PENDING_PASSWORD,
        isAuthorized: false,
      };
    }

    const message = isInvalidCodeError(error)
      ? 'Invalid or expired verification code.'
      : parseTelegramError(error);

    await prisma.userTelegramSession.update({
      where: { userId: params.userId },
      data: {
        status: USER_TELEGRAM_AUTH_STATUS.PENDING_CODE,
        sessionEncrypted: encryptString(serializeSession(client)),
        lastError: message,
      },
    });
    throw new Error(message);
  } finally {
    await disconnectClient(client);
  }
}

export async function submitUserTelegramAuthPassword(params: {
  userId: string;
  password: string;
}) {
  ensureMtprotoEnabled();
  const password = params.password.trim();
  if (!password) {
    throw new Error('2FA password is required.');
  }

  const session = await prisma.userTelegramSession.findUnique({
    where: { userId: params.userId },
  });

  if (!session) {
    throw new Error('Telegram session is not started.');
  }

  if (session.status !== USER_TELEGRAM_AUTH_STATUS.PENDING_PASSWORD) {
    throw new Error('2FA password is not expected for the current session state.');
  }

  const sessionValue = decryptString(session.sessionEncrypted) || '';
  const { client, runtime } = await createMtprotoClient(sessionValue);
  try {
    await signInWithPassword(client, runtime, password);

    await prisma.userTelegramSession.update({
      where: { userId: params.userId },
      data: {
        status: USER_TELEGRAM_AUTH_STATUS.AUTHORIZED,
        sessionEncrypted: encryptString(serializeSession(client)),
        authStateEncrypted: null,
        lastAuthorizedAt: new Date(),
        lastError: null,
      },
    });

    return {
      status: USER_TELEGRAM_AUTH_STATUS.AUTHORIZED,
      isAuthorized: true,
    };
  } catch (error) {
    const message = parseTelegramError(error);
    await prisma.userTelegramSession.update({
      where: { userId: params.userId },
      data: {
        status: USER_TELEGRAM_AUTH_STATUS.PENDING_PASSWORD,
        sessionEncrypted: encryptString(serializeSession(client)),
        lastError: message,
      },
    });
    throw new Error(message);
  } finally {
    await disconnectClient(client);
  }
}

export async function disconnectUserTelegramAuth(params: { userId: string }) {
  const existing = await prisma.userTelegramSession.findUnique({
    where: { userId: params.userId },
  });

  if (!existing) {
    return { disconnected: true };
  }

  await prisma.userTelegramSession.delete({
    where: { userId: params.userId },
  });

  return { disconnected: true };
}

export async function getAuthorizedUserMtprotoSession(userId: string): Promise<string | null> {
  const session = await prisma.userTelegramSession.findUnique({
    where: { userId },
    select: {
      status: true,
      sessionEncrypted: true,
    },
  });

  if (!session || session.status !== USER_TELEGRAM_AUTH_STATUS.AUTHORIZED) {
    return null;
  }

  return decryptString(session.sessionEncrypted);
}

export async function hasAuthorizedUserMtprotoSession(userId: string): Promise<boolean> {
  const session = await prisma.userTelegramSession.findUnique({
    where: { userId },
    select: { status: true },
  });

  return session?.status === USER_TELEGRAM_AUTH_STATUS.AUTHORIZED;
}

export async function persistAuthorizedUserMtprotoSession(
  userId: string,
  serializedSession: string,
): Promise<void> {
  if (!serializedSession) {
    return;
  }

  await prisma.userTelegramSession.updateMany({
    where: {
      userId,
      status: USER_TELEGRAM_AUTH_STATUS.AUTHORIZED,
    },
    data: {
      sessionEncrypted: encryptString(serializedSession),
      lastError: null,
    },
  });
}

export async function setUserTelegramSessionError(
  userId: string,
  message: string | null,
): Promise<void> {
  await prisma.userTelegramSession.updateMany({
    where: { userId },
    data: { lastError: message },
  });
}
