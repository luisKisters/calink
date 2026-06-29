export function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function maskSecret(secret: string): string {
  if (secret.length <= 10) {
    return "********";
  }
  return `${secret.slice(0, 6)}...${secret.slice(-4)}`;
}
