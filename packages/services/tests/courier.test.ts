import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { makeContext, openBiereau, createClient, DEMO, type TestContext } from './helpers.ts';
import {
  onboardingStatus, applyAsCourier, submitTraining, signContract,
  bookShift, cancelShiftBooking, earningsSummary, idempotent,
} from '../src/usecases/courier.ts';

let ctx: TestContext;

before(async () => { ctx = makeContext(); await openBiereau(ctx); });
after(async () => { await ctx.close(); });

const deps = () => ({ db: ctx.db, clock: ctx.clock });

/** A verified adult with no courier profile yet. */
async function candidate(): Promise<string> {
  const { userId } = await createClient(ctx);
  return userId;
}

/** The answer key, read directly — only a test may do this. */
async function correctAnswers(): Promise<Record<string, number>> {
  const rows = await ctx.sql`
    select id, correct_index from training_questions where active`;
  return Object.fromEntries(rows.map(r => [r['id'] as string, Number(r['correct_index'])]));
}

async function wrongAnswers(): Promise<Record<string, number>> {
  const rows = await ctx.sql`
    select id, correct_index, jsonb_array_length(choices) as n
      from training_questions where active`;
  return Object.fromEntries(rows.map(r =>
    [r['id'] as string, (Number(r['correct_index']) + 1) % Number(r['n'])]));
}

/** Publishes a shift that is open right now, within working-time limits. */
async function shiftNow(hours = 2): Promise<string> {
  const saved = await ctx.sql`
    select key, value from app_settings
     where key in ('work.service_end_time', 'work.night_work_threshold_time')`;
  await ctx.sql`
    update app_settings set value = '"23:59"'::jsonb
     where key in ('work.service_end_time', 'work.night_work_threshold_time')`;

  const [shift] = await ctx.sql`
    insert into shifts (zone_id, starts_at, ends_at, places, published_by,
                        night_derogation, derogation_validated_by, derogation_note)
    values (${DEMO.zoneBiereau}, now() - interval '30 minutes',
            now() + make_interval(hours => ${hours}),
            20, ${DEMO.admin}, true, ${DEMO.admin}, 'Fixture')
    returning id`;

  for (const row of saved) {
    await ctx.sql`update app_settings set value = ${row['value'] as object}
                   where key = ${row['key'] as string}`;
  }
  return shift!['id'] as string;
}

describe('candidature et prérequis — §7.1 à §7.3', () => {
  test('un compte sans candidature sait quoi faire', async () => {
    const status = await onboardingStatus(deps(), await candidate());
    assert.equal(status.applied, false);
    assert.equal(status.canWork, false);
    assert.match(status.nextStep, /candidature/i);
  });

  test('la capacité vient du moyen de transport, pas du candidat (§14)', async () => {
    const user = await candidate();
    await applyAsCourier(deps(), {
      userId: user, transport: 'cargo_bike', enrolmentProofRef: 'ATT-001',
    });

    const profile = await ctx.db.courier.profile(user);
    const expected = await ctx.db.settings.int('courier.capacity_cargo_bike');
    assert.equal(profile?.capacityUnits, expected);
  });

  test('après candidature, la formation est la prochaine étape', async () => {
    const user = await candidate();
    await applyAsCourier(deps(), {
      userId: user, transport: 'foot_trolley', enrolmentProofRef: 'ATT-002',
    });

    const status = await onboardingStatus(deps(), user);
    assert.equal(status.applied, true);
    assert.equal(status.trainingPassed, false);
    assert.match(status.nextStep, /formation/i);
  });

  test('un quiz raté ne valide pas la formation', async () => {
    const user = await candidate();
    await applyAsCourier(deps(), {
      userId: user, transport: 'bike_trailer', enrolmentProofRef: 'ATT-003',
    });

    const result = await submitTraining(deps(), {
      courierId: user, answers: await wrongAnswers(),
    });

    assert.equal(result.passed, false);
    assert.ok(result.wrong.length > 0, 'les erreurs doivent être expliquées');
    assert.ok(result.wrong[0]!.explanation.length > 0);

    const status = await onboardingStatus(deps(), user);
    assert.equal(status.trainingPassed, false);
  });

  test('un quiz réussi valide la formation', async () => {
    const user = await candidate();
    await applyAsCourier(deps(), {
      userId: user, transport: 'foot_trolley', enrolmentProofRef: 'ATT-004',
    });

    const result = await submitTraining(deps(), {
      courierId: user, answers: await correctAnswers(),
    });

    assert.equal(result.passed, true);
    assert.equal(result.score, result.total);

    const status = await onboardingStatus(deps(), user);
    assert.equal(status.trainingPassed, true);
    assert.match(status.nextStep, /contrat/i);
  });

  test("un quiz mélangé reste réussissable : l'identifiant d'une proposition ne bouge pas",
    async () => {
      // Régression. Le quiz mélange les propositions par palettier pour que
      // répondre par position ne serve à rien. Une version antérieure comparait
      // l'indice AFFICHÉ à l'indice d'origine : la formation obligatoire était
      // alors impossible à valider, même en répondant juste partout.
      const user = await candidate();
      await applyAsCourier(deps(), {
        userId: user, transport: 'foot_trolley', enrolmentProofRef: 'ATT-SHUFFLE',
      });

      const quiz = await ctx.db.courier.quiz(12345);
      const key = await ctx.sql`
        select id, choices, correct_index from training_questions where active`;
      const correctLabel = new Map(key.map(r =>
        [r['id'] as string, (r['choices'] as string[])[Number(r['correct_index'])]]));

      // On répond comme le ferait un palettier : en choisissant le bon LIBELLÉ
      // là où il se trouve à l'écran.
      const answers: Record<string, number> = {};
      let shuffled = false;

      for (const question of quiz) {
        const label = correctLabel.get(question.questionId)!;
        const position = question.choices.findIndex(c => c.label === label);
        const choice = question.choices[position]!;
        answers[question.questionId] = choice.id;
        if (choice.id !== position) shuffled = true;
      }

      assert.ok(shuffled, "l'ordre d'affichage doit bien être mélangé");

      const result = await submitTraining(deps(), { courierId: user, answers });
      assert.equal(result.passed, true, 'répondre juste doit suffire à valider');
      assert.equal(result.score, result.total);
    });

  test('le contrat ne peut pas être signé avant la formation (§7.2, §7.3)', async () => {
    const user = await candidate();
    await applyAsCourier(deps(), {
      userId: user, transport: 'foot_trolley', enrolmentProofRef: 'ATT-005',
    });

    await assert.rejects(() => signContract(deps(), { courierId: user }),
      /formation obligatoire/i);
  });

  test("le compte n'est actif qu'avec contrat ET Dimona (§7.3)", async () => {
    const user = await candidate();
    await applyAsCourier(deps(), {
      userId: user, transport: 'cargo_bike', enrolmentProofRef: 'ATT-006',
    });
    await submitTraining(deps(), { courierId: user, answers: await correctAnswers() });

    const afterContract = await signContract(deps(), { courierId: user });
    assert.equal(afterContract.contractSigned, true);
    assert.equal(afterContract.canWork, false, 'la Dimona manque encore');
    assert.match(afterContract.nextStep, /Dimona/);

    await ctx.db.courier.confirmDimona(user, DEMO.admin);

    const ready = await onboardingStatus(deps(), user);
    assert.equal(ready.canWork, true);
    assert.equal(ready.status, 'active');
    assert.match(ready.nextStep, /créneau/i);
  });
});

describe('créneaux — §7.4 et §14', () => {
  /** A courier who has completed every prerequisite. */
  async function readyCourier(): Promise<string> {
    const user = await candidate();
    await applyAsCourier(deps(), {
      userId: user, transport: 'cargo_bike', enrolmentProofRef: `ATT-${randomUUID().slice(0, 8)}`,
    });
    await submitTraining(deps(), { courierId: user, answers: await correctAnswers() });
    await signContract(deps(), { courierId: user });
    await ctx.db.courier.confirmDimona(user, DEMO.admin);
    return user;
  }

  test('un palettier sans formation ne peut pas réserver', async () => {
    const user = await candidate();
    await applyAsCourier(deps(), {
      userId: user, transport: 'foot_trolley', enrolmentProofRef: 'ATT-007',
    });
    const shift = await shiftNow();

    await assert.rejects(() => bookShift(deps(), { courierId: user, shiftId: shift }),
      (error: unknown) => {
        // Le message doit dire quoi faire, pas seulement que c'est refusé.
        assert.match((error as Error).message, /formation obligatoire/i);
        return true;
      });
  });

  test('un palettier prêt peut réserver puis annuler', async () => {
    const user = await readyCourier();
    const shift = await shiftNow();

    const booked = await bookShift(deps(), { courierId: user, shiftId: shift });
    assert.ok(booked.bookingId);

    const bookings = await ctx.db.courier.bookings(user);
    assert.equal(bookings.filter(b => b.cancelledAt === null).length, 1);

    await cancelShiftBooking(deps(), { courierId: user, shiftId: shift });
    const after = await ctx.db.courier.bookings(user);
    assert.equal(after.filter(b => b.cancelledAt === null).length, 0);
  });

  test('les créneaux proposés ne concernent que les quartiers ouverts', async () => {
    const user = await readyCourier();
    await shiftNow();

    const shifts = await ctx.db.courier.openShifts(user);
    assert.ok(shifts.length > 0);
    for (const s of shifts) {
      assert.equal(s.zoneName, 'Biéreau', 'seul Biéreau est ouvert dans le jeu de démonstration');
    }
  });

  test('réserver au-delà de la durée maximale quotidienne est refusé (§14)', async () => {
    const user = await readyCourier();
    const maxDay = await ctx.db.settings.int('work.max_hours_per_day');

    const saved = await ctx.sql`
      select key, value from app_settings
       where key in ('work.service_end_time', 'work.night_work_threshold_time')`;
    await ctx.sql`
      update app_settings set value = '"23:59"'::jsonb
       where key in ('work.service_end_time', 'work.night_work_threshold_time')`;

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const [long] = await ctx.sql`
      insert into shifts (zone_id, starts_at, ends_at, places, published_by)
      values (${DEMO.zoneBiereau}, ${`${tomorrow} 08:00+01`}::timestamptz,
              ${`${tomorrow} 15:00+01`}::timestamptz, 5, ${DEMO.admin})
      returning id`;
    const [extra] = await ctx.sql`
      insert into shifts (zone_id, starts_at, ends_at, places, published_by)
      values (${DEMO.zoneBiereau}, ${`${tomorrow} 15:30+01`}::timestamptz,
              ${`${tomorrow} 18:30+01`}::timestamptz, 5, ${DEMO.admin})
      returning id`;

    for (const row of saved) {
      await ctx.sql`update app_settings set value = ${row['value'] as object}
                     where key = ${row['key'] as string}`;
    }

    await bookShift(deps(), { courierId: user, shiftId: long!['id'] as string });

    await assert.rejects(
      () => bookShift(deps(), { courierId: user, shiftId: extra!['id'] as string }),
      (error: unknown) => {
        assert.match((error as Error).message, /durée maximale de travail/i);
        assert.equal((error as { kind?: string }).kind, 'working_time');
        return true;
      });
    void maxDay;
  });
});

describe('mode hors ligne : idempotence — §18', () => {
  test('rejouer une action ne la refait pas', async () => {
    const user = await candidate();
    const actionId = randomUUID();
    let runs = 0;

    const first = await idempotent(deps(), { actionId, courierId: user, kind: 'test' },
      async () => { runs += 1; return { value: runs }; });
    const second = await idempotent(deps(), { actionId, courierId: user, kind: 'test' },
      async () => { runs += 1; return { value: runs }; });

    assert.equal(runs, 1, "l'action ne doit être exécutée qu'une fois");
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.deepEqual(second.result, first.result,
      'un rejeu doit renvoyer exactement le résultat initial');
  });

  test('réutiliser un identifiant pour une autre action est refusé', async () => {
    const user = await candidate();
    const actionId = randomUUID();

    await idempotent(deps(), { actionId, courierId: user, kind: 'book_shift' },
      async () => ({ ok: true }));

    await assert.rejects(
      () => idempotent(deps(), { actionId, courierId: user, kind: 'age_check' },
        async () => ({ ok: true })),
      /déjà servi/i);
  });

  test('sans identifiant, chaque appel agit', async () => {
    const user = await candidate();
    let runs = 0;

    await idempotent(deps(), { courierId: user, kind: 'test' },
      async () => { runs += 1; return runs; });
    await idempotent(deps(), { courierId: user, kind: 'test' },
      async () => { runs += 1; return runs; });

    assert.equal(runs, 2);
  });

  test('une candidature rejouée ne crée pas deux profils', async () => {
    const user = await candidate();
    const actionId = randomUUID();

    await applyAsCourier(deps(), {
      userId: user, transport: 'foot_trolley', enrolmentProofRef: 'ATT-IDEM', actionId,
    });
    await applyAsCourier(deps(), {
      userId: user, transport: 'cargo_bike', enrolmentProofRef: 'ATT-AUTRE', actionId,
    });

    const [{ n }] = await ctx.sql`
      select count(*)::int as n from courier_profiles where user_id = ${user}` as any;
    assert.equal(n, 1);

    const profile = await ctx.db.courier.profile(user);
    assert.equal(profile?.transport, 'foot_trolley',
      'le rejeu ne doit pas écraser la première candidature');
  });
});

describe('heures, quota et gains — §7.4 et §7.8', () => {
  test("l'estimation est explicitement présentée comme telle (§7.8)", async () => {
    const user = await candidate();
    await applyAsCourier(deps(), {
      userId: user, transport: 'foot_trolley', enrolmentProofRef: 'ATT-008',
    });

    const summary = await earningsSummary(deps(), {
      courierId: user,
      from: new Date(Date.now() - 30 * 86_400_000),
      to: new Date(),
    });

    assert.match(summary.disclaimer, /estimation/i);
    assert.match(summary.disclaimer, /secrétariat social/i);
    assert.match(summary.disclaimer, /Student@work/);
  });

  test('le quota annuel est rapporté avec son seuil d\'alerte', async () => {
    const user = await candidate();
    await applyAsCourier(deps(), {
      userId: user, transport: 'foot_trolley', enrolmentProofRef: 'ATT-009',
    });

    const quota = await ctx.db.courier.quotaStatus(user);
    assert.equal(quota.quotaHours, 650);
    assert.equal(quota.alerting, false);
    assert.ok(quota.alertThresholdHours < quota.quotaHours);
  });

  test('les heures comptent le créneau réservé, pas le temps en mission (§11)', async () => {
    const user = await candidate();
    await applyAsCourier(deps(), {
      userId: user, transport: 'cargo_bike', enrolmentProofRef: 'ATT-010',
    });
    await submitTraining(deps(), { courierId: user, answers: await correctAnswers() });
    await signContract(deps(), { courierId: user });
    await ctx.db.courier.confirmDimona(user, DEMO.admin);

    const shift = await shiftNow(2);
    await bookShift(deps(), { courierId: user, shiftId: shift });

    const hours = await ctx.db.courier.hours(
      user, new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000));

    // 30 minutes already elapsed plus 2 hours ahead: the whole window counts,
    // because a courier is paid for waiting.
    assert.ok(hours > 2 && hours < 3, `heures comptées : ${hours}`);
  });
});
