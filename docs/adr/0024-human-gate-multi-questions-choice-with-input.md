# human_gate複数設問・choice_with_input対応

tado 0.1.0で HumanGateStepDefが `questions`/`outcomeQuestionKey`/`GateAnswer` へ破壊的再設計されたことに伴い、tools側7WF14gateを新仕様に完全移行する。request_changesは必須入力500文字・approveは任意入力500文字で統一、width/depthは3設問化（width/depth/decision）で gate で明示選択、free_textは見送り。旧 choice セッションは破壊的変更として考慮不要。

> 注記（新エンジン追随・plan 97）: 初版記録の revise 選択は新エンジン契約で撤去され、値語彙は approve / request_changes / abort となった（必須入力は request_changes が継承）。human_gate の責務は確認と回答保存のみ（check は実行されない）で、差し戻しの巻き戻しは loop の continue が担う。旧 revise 値は互換受理せず fail で検出する。
