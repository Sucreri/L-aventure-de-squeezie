/**
 * The mandatory training (spec 7.2).
 *
 * The answer key never reaches this screen: the server grades the attempt and
 * sends back which answers were wrong, with an explanation. That is also why
 * a failed attempt is useful rather than punitive — the courier learns the
 * rule they got wrong before they are at someone's door.
 */

import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { Screen, Title, Body, Small, Button, Card, Divider, Loading, ErrorBanner }
  from '../../src/components/ui';
import { courierApi, ApiError, type QuizQuestion } from '../../src/api';
import { useSession } from '../../src/session';
import { spacing } from '../../src/theme';

interface Result {
  score: number; total: number; passed: boolean;
  wrong: Array<{ prompt: string; explanation: string }>;
}

export default function Formation() {
  const router = useRouter();
  const session = useSession();

  const [questions, setQuestions] = useState<QuizQuestion[] | null>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [result, setResult] = useState<Result | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session.token) return;
    courierApi.training(session.token)
      .then(r => setQuestions(r.questions))
      .catch(e => setFailure(e.message));
  }, [session.token]);

  async function submit() {
    if (!session.token) return;
    setBusy(true);
    setFailure(null);

    try {
      setResult(await courierApi.submitTraining(session.token, answers));
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Une erreur est survenue.');
    } finally {
      setBusy(false);
    }
  }

  function retry() {
    setResult(null);
    setAnswers({});
  }

  if (failure) return <Screen><ErrorBanner message={failure} /></Screen>;
  if (!questions) return <Screen><Loading /></Screen>;

  if (result) {
    return (
      <Screen>
        <Title>{result.passed ? 'Formation validée' : 'Pas encore'}</Title>

        <Card tone={result.passed ? 'success' : 'notice'}>
          <Body>{result.score} bonnes réponses sur {result.total}.</Body>
          {result.passed ? (
            <Small>
              Tu peux maintenant signer ton contrat d'occupation d'étudiant.
            </Small>
          ) : (
            <Small>
              Relis les points ci-dessous et recommence. Il n'y a pas de limite
              de tentatives : l'objectif est que tu saches quoi faire à la
              porte, pas de te noter.
            </Small>
          )}
        </Card>

        {result.wrong.length > 0 ? (
          <>
            <Divider />
            <Small muted={false}>À revoir</Small>
            <View style={{ height: spacing.sm }} />
            {result.wrong.map((item, index) => (
              <Card key={index}>
                <Body>{item.prompt}</Body>
                <View style={{ height: spacing.sm }} />
                <Small muted={false}>{item.explanation}</Small>
              </Card>
            ))}
          </>
        ) : null}

        {result.passed
          ? <Button label="Voir mon contrat" onPress={() => router.replace('/palettier/contrat')} />
          : <Button label="Recommencer" onPress={retry} />}
      </Screen>
    );
  }

  const answered = Object.keys(answers).length;

  return (
    <Screen>
      <Title>Formation obligatoire</Title>
      <Body muted>
        Âges légaux, refus de remise, contrôle d'une pièce d'identité, port de
        charges, sécurité à vélo. Ce sont les situations que tu rencontreras.
      </Body>

      <View style={{ height: spacing.lg }} />

      {questions.map((question, index) => (
        <Card key={question.questionId}>
          <Small muted={false}>Question {index + 1} sur {questions.length}</Small>
          <View style={{ height: spacing.xs }} />
          <Body>{question.prompt}</Body>
          <View style={{ height: spacing.sm }} />

          {question.choices.map(choice => (
            <Button
              key={choice.id}
              label={choice.label}
              // The submitted value is the choice's stable id, not its
              // position: the server shuffles the display order.
              variant={answers[question.questionId] === choice.id ? 'primary' : 'secondary'}
              onPress={() => setAnswers(current =>
                ({ ...current, [question.questionId]: choice.id }))}
            />
          ))}
        </Card>
      ))}

      <Button
        label={`Valider (${answered} / ${questions.length})`}
        onPress={submit}
        disabled={answered < questions.length}
        loading={busy}
      />
    </Screen>
  );
}
