import { getRepositoryToken } from '@mikro-orm/nestjs';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { RealtimeGateway } from '../realtime/realtime.module';
import { CommissionService } from '../commission/commission.service';
import { CommissionCase } from '../commission/entities/commission-case.entity';
import { Sanction } from '../commission/entities/sanction.entity';
import { RecoursService } from '../recours/recours.service';
import { Recours } from '../recours/entities/recours.entity';
import { ANTIVIRUS_SCANNER } from './antivirus';
import { DocumentsService } from './documents.module';
import { Document } from './entities/document.entity';
import { STORAGE_PROVIDER } from './documents.tokens';
import { StorageProvider } from './providers/storage-provider.interface';
import { simulatedDatabaseOutage, simulatedOutageEntityManager } from '../common/database/db-errors';

/** Acteur scopé compagnie — voir recours.service.spec.ts/commission.service.spec.ts. */
function correspondant(name: string, companyId: string): AuthenticatedUser {
  return { id: name, name, email: `${name}@test.local`, role: 'CORRESPONDANT_IDA', companyId, privileges: ['insert'] };
}
function placeUser(name = 'operateur.place'): AuthenticatedUser {
  return { id: name, name, email: `${name}@test.local`, role: 'OPERATEUR_PLACE', privileges: ['insert'] };
}

/** Repli mémoire forcé — même idiome que recours.service.spec.ts/commission.service.spec.ts/adherents.service.spec.ts `throwingRepo()`. */
function throwingRepo() {
  return {
    create: jest.fn((data: unknown) => data),
    findOne: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
    findAll: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
    find: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
    getEntityManager: jest.fn(() => simulatedOutageEntityManager({
      persist: jest.fn(),
      persistAndFlush: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
      flush: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
    })),
  };
}

function fakeConfigService() {
  return { get: () => undefined } as unknown as ConfigService;
}

/** Fausse implémentation de StorageProvider (mode local : pas d'URL pré-signée) — pas de disque/S3 réel dans ces tests unitaires. */
const stored = new Map<string, Buffer>();
function fakeStorageProvider(): StorageProvider {
  return {
    mode: 'LOCAL_FS_DEGRADED',
    put: jest.fn(async (key: string, content: Buffer, contentType: string) => {
      stored.set(key, content);
      return { key, sizeBytes: content.length, contentType };
    }),
    get: jest.fn(async (key: string) => stored.get(key)!),
  };
}

const file = { originalname: 'constat.pdf', buffer: Buffer.from('%PDF-1.4 contenu test'), mimetype: 'application/pdf' };

describe('DocumentsService (mode dégradé — QUESTIONS_UAR.md §9, attachement Recours/CommissionCase)', () => {
  let documents: DocumentsService;
  let recours: RecoursService;
  let commission: CommissionService;
  let antivirus: { mode: 'DISABLED'; scan: jest.Mock };

  beforeEach(async () => {
    antivirus = { mode: 'DISABLED', scan: jest.fn(async () => ({ clean: true })) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        DocumentsService,
        RecoursService,
        CommissionService,
        { provide: STORAGE_PROVIDER, useFactory: fakeStorageProvider },
        { provide: getRepositoryToken(Document), useFactory: throwingRepo },
        { provide: getRepositoryToken(Recours), useFactory: throwingRepo },
        { provide: getRepositoryToken(CommissionCase), useFactory: throwingRepo },
        { provide: getRepositoryToken(Sanction), useFactory: throwingRepo },
        { provide: ConfigService, useFactory: fakeConfigService },
        { provide: RealtimeGateway, useValue: { emitEvent: jest.fn() } },
        { provide: ANTIVIRUS_SCANNER, useValue: antivirus },
      ],
    }).compile();

    documents = moduleRef.get(DocumentsService);
    recours = moduleRef.get(RecoursService);
    commission = moduleRef.get(CommissionService);
  });

  it('upload() sans recoursId/commissionCaseId reste un document non attaché (comportement historique préservé)', async () => {
    const res = await documents.upload(file, placeUser());
    expect(res.url).toBe(`/api/v1/documents/${res.id}/download`);
    expect(res).not.toHaveProperty('key');

    // Pas d'attachement -> non listable par recoursId/commissionCaseId.
    await expect(documents.listForDossier({ recoursId: 'inexistant' }, placeUser())).rejects.toMatchObject({ status: 404 });
  });

  it('upload() refuse avec un 400 un document attaché aux DEUX dossiers à la fois', async () => {
    await expect(documents.upload(file, placeUser(), 'r1', 'c1')).rejects.toMatchObject({ status: 400 });
  });

  it('upload() attaché à un recours persiste (repli mémoire) et devient listable via listForDossier', async () => {
    const r = await recours.create({ claimId: 'clm-doc-1', from: 'CAAT', to: 'SAA', amount: 42_000 });

    await documents.upload(file, correspondant('c.caat', 'CAAT'), r.id, undefined);

    const list = await documents.listForDossier({ recoursId: r.id }, correspondant('c.caat', 'CAAT'));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ filename: 'constat.pdf', contentType: 'application/pdf', uploadedBy: 'c.caat' });
    expect(list[0].url).toBe(`/api/v1/documents/${list[0].id}/download`);
  });

  it("upload() refuse (404 uniforme, SEC-46) qu'une compagnie tierce attache un document à un recours auquel elle n'est pas partie", async () => {
    const r = await recours.create({ claimId: 'clm-doc-2', from: 'CAAT', to: 'SAA', amount: 42_000 });
    await expect(documents.upload(file, correspondant('c.caar', 'CAAR'), r.id, undefined)).rejects.toMatchObject({ status: 404 });
  });

  it("listForDossier() refuse (404 uniforme, SEC-46) qu'une compagnie tierce liste les documents d'un recours auquel elle n'est pas partie", async () => {
    const r = await recours.create({ claimId: 'clm-doc-3', from: 'CAAT', to: 'SAA', amount: 42_000 });
    await documents.upload(file, correspondant('c.caat', 'CAAT'), r.id, undefined);

    await expect(documents.listForDossier({ recoursId: r.id }, correspondant('c.caar', 'CAAR'))).rejects.toMatchObject({ status: 404 });
  });

  it('listForDossier() renvoie 404 si le recours cité est introuvable', async () => {
    await expect(documents.listForDossier({ recoursId: 'introuvable' }, placeUser())).rejects.toMatchObject({ status: 404 });
  });

  it('listForDossier() renvoie 400 si ni recoursId ni commissionCaseId ne sont fournis, ou si les deux le sont', async () => {
    await expect(documents.listForDossier({}, placeUser())).rejects.toMatchObject({ status: 400 });
    await expect(documents.listForDossier({ recoursId: 'r1', commissionCaseId: 'c1' }, placeUser())).rejects.toMatchObject({ status: 400 });
  });

  it('upload() attaché à un dossier de commission persiste et devient listable via listForDossier', async () => {
    const r = await recours.create({ claimId: 'clm-doc-4', from: 'CAAT', to: 'SAA', amount: 60_000 });
    await recours.transition(r.id, { action: 'opposer' }, correspondant('c.saa', 'SAA'));
    await recours.transition(r.id, { action: 'contester' }, correspondant('c.caat', 'CAAT'));
    await recours.transition(r.id, { action: 'transmettre_commission' }, correspondant('c.caat', 'CAAT'));
    const kase = await commission.createCase({ recoursId: r.id, motif: 'Litige' }, placeUser());

    await documents.upload(file, placeUser(), undefined, kase.id);

    const list = await documents.listForDossier({ commissionCaseId: kase.id }, correspondant('c.caat', 'CAAT'));
    expect(list).toHaveLength(1);
    expect(list[0].filename).toBe('constat.pdf');
  });

  describe('SEC-10 — accès par identifiant, clés aléatoires', () => {
    it('clé de stockage aléatoire, sans le nom d’origine', async () => {
      const storage = (documents as unknown as { storage: StorageProvider }).storage;
      await documents.upload({ ...file, originalname: 'constat-Ahmed-Benali.pdf' }, correspondant('c.caat', 'CAAT'));
      const [key] = (storage.put as jest.Mock).mock.calls.at(-1)!;
      expect(key).toMatch(/^CAAT\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(key).not.toContain('Ahmed');
    });

    it('une pièce d’une autre compagnie renvoie 404 ; la compagnie propriétaire la télécharge', async () => {
      const res = await documents.upload(file, correspondant('c.caat', 'CAAT'));
      await expect(documents.download(res.id, correspondant('c.saa', 'SAA'))).rejects.toMatchObject({ status: 404 });
      await expect(documents.describe(res.id, correspondant('c.saa', 'SAA'))).rejects.toMatchObject({ status: 404 });
      const own = await documents.download(res.id, correspondant('c.caat', 'CAAT'));
      expect(own).toMatchObject({ filename: 'constat.pdf', contentType: 'application/pdf' });
      expect(own.content.toString()).toContain('%PDF');
      await expect(documents.download(res.id, placeUser())).resolves.toBeDefined();
    });

    it('pièce rattachée à un recours : les parties la téléchargent, une compagnie tierce reçoit 404', async () => {
      const r = await recours.create({ claimId: 'clm-doc-5', from: 'CAAT', to: 'SAA', amount: 42_000 });
      const res = await documents.upload(file, correspondant('c.caat', 'CAAT'), r.id);
      await expect(documents.download(res.id, correspondant('c.saa', 'SAA'))).resolves.toBeDefined();
      await expect(documents.download(res.id, correspondant('c.caar', 'CAAR'))).rejects.toMatchObject({ status: 404 });
    });

    it('document inconnu : 404', async () => {
      await expect(documents.download('00000000-0000-4000-8000-000000000000', placeUser())).rejects.toMatchObject({ status: 404 });
    });

    it('nom de fichier avec « .. », « / » ou caractère de contrôle refusé (400)', async () => {
      for (const originalname of ['../../etc/passwd', 'a/b.pdf', 'x\u0000.pdf', '..pdf']) {
        await expect(documents.upload({ ...file, originalname }, placeUser())).rejects.toMatchObject({ status: 400, response: { code: 'NOM_FICHIER_INVALIDE' } });
      }
    });
  });

  describe('SEC-29 — contenu des pièces', () => {
    it('un HTML ou un exécutable renommé en .pdf est refusé, rien n’est stocké', async () => {
      const storage = (documents as unknown as { storage: StorageProvider }).storage;
      (storage.put as jest.Mock).mockClear();
      await expect(documents.upload({ ...file, buffer: Buffer.from('<html><script>alert(1)</script>') }, placeUser())).rejects.toMatchObject({ response: { code: 'TYPE_NON_AUTORISE' } });
      await expect(documents.upload({ ...file, buffer: Buffer.from([0x4d, 0x5a, 0x90, 0x00]) }, placeUser())).rejects.toMatchObject({ response: { code: 'TYPE_NON_AUTORISE' } });
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('le fichier de test EICAR est refusé', async () => {
      const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
      await expect(documents.upload({ ...file, buffer: eicar }, placeUser())).rejects.toMatchObject({ status: 400 });
    });

    it('un PNG déclaré comme PDF est refusé (type incohérent)', async () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
      await expect(documents.upload({ ...file, buffer: png }, placeUser())).rejects.toMatchObject({ response: { code: 'TYPE_INCOHERENT' } });
      await expect(documents.upload({ ...file, buffer: png, mimetype: 'image/png', originalname: 'photo.png' }, placeUser())).resolves.toMatchObject({ contentType: 'image/png' });
    });

    it('un fichier signalé par l’antivirus est refusé (FICHIER_INFECTE)', async () => {
      antivirus.scan.mockResolvedValueOnce({ clean: false, signature: 'Eicar-Test-Signature' });
      await expect(documents.upload(file, placeUser())).rejects.toMatchObject({ response: { code: 'FICHIER_INFECTE' } });
    });
  });
});
