declare module '@vercel/blob' {
  export function generateClientTokenFromReadWriteToken(
    value: unknown,
  ): Promise<string> | string;
}
