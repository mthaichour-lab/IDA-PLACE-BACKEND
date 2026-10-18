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
import { DocumentsService } from './documents.module';
import { Document } from './entities/document.entity';
import { STORAGE_PROVIDER } from './documents.tokens';
import { StorageProvider } from './providers/storage-provider.interface';

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
    findOne: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    findAll: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    find: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    getEntityManager: jest.fn(() => ({
      persist: jest.fn(),
      persistAndFlush: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
      flush: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    })),
  };
}

function fakeConfigService() {
  return { get: () => undefined } as unknown as ConfigService;
}

/** Fausse implémentation de StorageProvider — pas de disque/S3 réel dans ces tests unitaires. */
function fakeStorageProvider(): StorageProvider {
  return {
    mode: 'LOCAL_FS_DEGRADED',
    put: jest.fn(async (key: string, content: Buffer, contentType: string) => ({ key, sizeBytes: content.length, contentType })),
    getPresignedUrl: jest.fn(async (key: string) => `/local/${key}`),
  };
}

const file = { originalname: 'constat.pdf', buffer: Buffer.from('contenu test'), mimetype: 'application/pdf' };

describe('DocumentsService (mode dégradé — QUESTIONS_UAR.md §9, attachement Recours/CommissionCase)', () => {
  let documents: DocumentsService;
  let recours: RecoursService;
  let commission: CommissionService;

  beforeEach(async () => {
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
      ],
    }).compile();

    documents = moduleRef.get(DocumentsService);
    recours = moduleRef.get(RecoursService);
    commission = moduleRef.get(CommissionService);
  });

  it('upload() sans recoursId/commissionCaseId reste un document non attaché (comportement historique préservé)', async () => {
    const res = await documents.upload(file, placeUser());
    expect(res.key).toMatch(/^place\//);
    expect(res.url).toBe(`/local/${res.key}`);

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
    expect(list[0].url).toMatch(/^\/local\//);
  });

  it("upload() refuse avec un 403 qu'une compagnie tierce attache un document à un recours auquel elle n'est pas partie", async () => {
    const r = await recours.create({ claimId: 'clm-doc-2', from: 'CAAT', to: 'SAA', amount: 42_000 });
    await expect(documents.upload(file, correspondant('c.caar', 'CAAR'), r.id, undefined)).rejects.toMatchObject({ status: 403 });
  });

  it("listForDossier() refuse avec un 403 qu'une compagnie tierce liste les documents d'un recours auquel elle n'est pas partie", async () => {
    const r = await recours.create({ claimId: 'clm-doc-3', from: 'CAAT', to: 'SAA', amount: 42_000 });
    await documents.upload(file, correspondant('c.caat', 'CAAT'), r.id, undefined);

    await expect(documents.listForDossier({ recoursId: r.id }, correspondant('c.caar', 'CAAR'))).rejects.toMatchObject({ status: 403 });
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

  it('presign() refuse avec un 403 une clé hors du préfixe compagnie de l’appelant', async () => {
    const res = await documents.upload(file, correspondant('c.caat', 'CAAT'));
    await expect(documents.presign(res.key, correspondant('c.saa', 'SAA'))).rejects.toMatchObject({ status: 403 });
    await expect(documents.presign(res.key, correspondant('c.caat', 'CAAT'))).resolves.toMatchObject({ key: res.key });
  });
});
