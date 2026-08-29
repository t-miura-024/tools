# human_gate複数設問・choice_with_input対応

tado 0.1.0で HumanGateStepDefが `questions`/`outcomeQuestionKey`/`GateAnswer` へ破壊的再設計されたことに伴い、tools側7WF14gateを新仕様に完全移行する。reviseは必須入力500文字・approveは任意入力500文字で統一、width/depthは3設問化（width/depth/decision）で gate で明示選択、free_textは見送り。旧 choice セッションは破壊的変更として考慮不要。
