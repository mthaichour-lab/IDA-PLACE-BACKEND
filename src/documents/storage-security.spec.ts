import { createServer, Server } from 'net';
import { AddressInfo } from 'net';
import { AntivirusFactory, ClamdAntivirusScanner } from './antivirus';
import { assertDocumentContent, detectDocumentType, safeOriginalFilename } from './content-validation';
import { LocalFsStorageProvider } from './providers/local-fs.provider';
import { S3StorageProvider } from './providers/s3.provider';
import { attachmentDisposition, resolveDocumentStorageConfig } from './storage-config';

const S3_ENV = { S3_ENABLED: 'true', S3_ENDPOINT: 'http://minio:9000', S3_BUCKET: 'docs', S3_ACCESS_KEY: 'k', S3_SECRET_KEY: 's' };

describe('SEC-11 — configuration du stockage des pièces', () => {
  it('production sans stockage objet : démarrage refusé', () => {
    expect(() => resolveDocumentStorageConfig({ NODE_ENV: 'production' })).toThrow(/obligatoire en production/);
    expect(() => resolveDocumentStorageConfig({ NODE_ENV: 'production', S3_ENABLED: 'false' })).toThrow(/obligatoire en production/);
  });

  it('production : configuration S3 incomplète ou SSE désactivé refusés', () => {
    expect(() => resolveDocumentStorageConfig({ NODE_ENV: 'production', S3_ENABLED: 'true', S3_BUCKET: 'b' })).toThrow(/configuration manquante/);
    expect(() => resolveDocumentStorageConfig({ NODE_ENV: 'production', ...S3_ENV, S3_SSE: 'none' })).toThrow(/S3_SSE=none refusé/);
  });

  it('SSE-S3 (AES256) demandé par défaut, SSE-KMS sur demande, valeur inconnue refusée', () => {
    expect(resolveDocumentStorageConfig({ NODE_ENV: 'production', ...S3_ENV })).toEqual({ useS3: true, sse: 'AES256', sseKmsKeyId: undefined });
    expect(resolveDocumentStorageConfig({ ...S3_ENV, S3_SSE: 'aws:kms', S3_SSE_KMS_KEY_ID: 'kms-1' })).toEqual({ useS3: true, sse: 'aws:kms', sseKmsKeyId: 'kms-1' });
    expect(() => resolveDocumentStorageConfig({ ...S3_ENV, S3_SSE: 'rot13' })).toThrow(/S3_SSE inconnu/);
    expect(resolveDocumentStorageConfig({ ...S3_ENV, S3_SSE: 'none' })).toEqual({ useS3: true });
  });

  it('hors production sans S3 : repli local de développement', () => {
    expect(resolveDocumentStorageConfig({ NODE_ENV: 'development' })).toEqual({ useS3: false });
  });

  it('S3StorageProvider transmet le chiffrement côté serveur à chaque dépôt', () => {
    const saved = { ...process.env };
    Object.assign(process.env, S3_ENV, { S3_SSE: 'aws:kms', S3_SSE_KMS_KEY_ID: 'kms-42' });
    try {
      expect(new S3StorageProvider().sseParams()).toEqual({ ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'kms-42' });
    } finally {
      process.env = saved;
    }
  });

  it('le stockage local n’a plus de secret de repli ni d’URL signée maison', () => {
    const local = new LocalFsStorageProvider() as unknown as Record<string, unknown>;
    expect(local.secret).toBeUndefined();
    expect(local.getPresignedUrl).toBeUndefined();
    expect(local.presignedDownloadUrl).toBeUndefined();
  });

  it('Content-Disposition en pièce jointe, nom neutralisé', () => {
    expect(attachmentDisposition('constat.pdf')).toBe(`attachment; filename="constat.pdf"; filename*=UTF-8''constat.pdf`);
    expect(attachmentDisposition('a"b.pdf')).toMatch(/^attachment; filename="a_b\.pdf"/);
  });
});

describe('SEC-29 — signature des octets', () => {
  it('reconnaît PDF, JPEG, PNG et WEBP réels', () => {
    expect(detectDocumentType(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(detectDocumentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectDocumentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(detectDocumentType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe('image/webp');
  });

  it('refuse un faux PDF, un HTML et le fichier EICAR', () => {
    for (const content of ['<!doctype html><script>', 'MZ\x90\x00', 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*', ' %PDF-1.4']) {
      expect(() => assertDocumentContent(Buffer.from(content, 'latin1'), 'application/pdf')).toThrow();
    }
  });

  it('nom d’origine : traversée et caractères de contrôle refusés, le reste neutralisé', () => {
    expect(() => safeOriginalFilename('../x.pdf')).toThrow();
    expect(() => safeOriginalFilename('dir\\x.pdf')).toThrow();
    expect(() => safeOriginalFilename('x\r\n.pdf')).toThrow();
    expect(safeOriginalFilename('Constat Ahmed é.pdf')).toBe('Constat_Ahmed__.pdf');
    expect(safeOriginalFilename('')).toBe('fichier');
  });
});

describe('SEC-29 — antivirus branchable', () => {
  let server: Server;
  let reply: string;
  let received: Buffer;

  beforeAll(async () => {
    server = createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (d) => {
        chunks.push(d);
        const all = Buffer.concat(chunks);
        // Fin du flux INSTREAM : bloc de longueur nulle.
        if (all.length >= 4 && all.subarray(all.length - 4).readUInt32BE(0) === 0) {
          received = all;
          socket.end(`${reply}\0`);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const scanner = () => new ClamdAntivirusScanner({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, timeoutMs: 2000 });

  it('désactivé par défaut ; mode inconnu refusé au démarrage', () => {
    expect(new AntivirusFactory().create({}).mode).toBe('DISABLED');
    expect(new AntivirusFactory().create({ ANTIVIRUS_MODE: 'clamd' }).mode).toBe('CLAMD');
    expect(() => new AntivirusFactory().create({ ANTIVIRUS_MODE: 'magique' })).toThrow();
  });

  it('clamd : fichier sain accepté, protocole INSTREAM respecté', async () => {
    reply = 'stream: OK';
    await expect(scanner().scan(Buffer.from('%PDF-1.4 sain'))).resolves.toEqual({ clean: true });
    expect(received.subarray(0, 10).toString()).toBe('zINSTREAM\0');
  });

  it('clamd : fichier EICAR signalé', async () => {
    reply = 'stream: Eicar-Test-Signature FOUND';
    await expect(scanner().scan(Buffer.from('X5O!P%@AP'))).resolves.toEqual({ clean: false, signature: 'Eicar-Test-Signature' });
  });

  it('clamd injoignable : dépôt refusé (503), jamais accepté par défaut', async () => {
    const down = new ClamdAntivirusScanner({ host: '127.0.0.1', port: 1, timeoutMs: 1000 });
    await expect(down.scan(Buffer.from('x'))).rejects.toMatchObject({ status: 503 });
  });
});
