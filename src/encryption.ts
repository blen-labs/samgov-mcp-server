import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type SealedKey = { version: 1; keyId: string; iv: string; ciphertext: string; tag: string };

/** Keys are supplied by the host secret store, separately from the database. */
export class KeyVault {
  private readonly keys: Map<string, Buffer>;
  constructor(
    private readonly activeKeyId: string,
    keys: Record<string, string>,
  ) {
    this.keys = new Map(
      Object.entries(keys).map(([id, encoded]) => {
        const key = Buffer.from(encoded, 'base64');
        if (
          !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
          key.length !== 32 ||
          key.toString('base64') !== encoded
        ) {
          throw new Error(
            'Each encryption key must have a valid ID and contain exactly 32 bytes encoded as canonical base64.',
          );
        }
        return [id, key];
      }),
    );
    if (!this.keys.has(activeKeyId)) throw new Error('Active encryption key is missing.');
  }

  seal(tenantId: string, secret: string): SealedKey {
    if (!tenantId || !secret.trim() || secret.length > 131072)
      throw new Error('Invalid tenant or credential.');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.activeKeyId)!, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(['samgov-api-key', 1, tenantId, this.activeKeyId])));
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return {
      version: 1,
      keyId: this.activeKeyId,
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  }

  open(tenantId: string, sealed: SealedKey): string {
    try {
      const key = this.keys.get(sealed.keyId);
      if (sealed.version !== 1 || !key) throw new Error();
      const iv = Buffer.from(sealed.iv, 'base64');
      const tag = Buffer.from(sealed.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(JSON.stringify(['samgov-api-key', 1, tenantId, sealed.keyId])));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error('Stored credential could not be decrypted.');
    }
  }
}
