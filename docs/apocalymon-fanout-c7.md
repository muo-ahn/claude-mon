# C7 apocalymon 쏠림 해소: 원작 최종체 엣지 조사 결과 (결정 D-18, D-19)

재현: `node scripts/add-apocalymon-fanout.js --cache <wikimon-cache 경로>` (dry-run, `--write` 로 반영). 네트워크 조회 없음.

## 결과: 추가 엣지 0개

apocalymon 단일 자식 완전체 10개(ancientmegatheriumon, ancientmermaimon, ancientsphinxmon, ancienttroiamon, ancientvolcamon, gigaseadramon, metalseadramon, mugendramon, piemon, pinochimon)를 `Evolves From` 으로 가진 최종체를 캐시 wikitext 에서 찾았다. 그래프의 최종체 30개 중 25개는 캐시에서 확인했고, 이 10개를 부모로 가진 것은 apocalymon 뿐이다(이미 엣지 있음). 나머지 후보는 모두 D-19 조건 밖이다.

| 최종체 | 근거 페이지 | 제외 사유 |
|---|---|---|
| armagemon | Armagemon.wikitext | piemon·mugendramon·metalseadramon 모두 `(with Diablomon)` 조그레스. 조그레스 제외 정책(global-graph-plan §7) |
| zeedmillenniumon | Zeed Millenniumon.wikitext | mugendramon `(with Millenniumon ... or Chimairamon ...)` 조그레스 |
| omegamon | Omegamon.wikitext | mugendramon `(with Gabumon, Garurumon ...)` 조그레스 |

그래프에서 최종체가 아닌 노드(millenniumon, moonmillenniumon, lucemon_satanmode, gigaseadramon 등)와 그래프에 없는 노드(huanglongmon, chaosdramon 등)는 대상이 아니다.

## 미확인 최종체 5개 (캐시에 페이지 없음, 네트워크 조회 금지로 보류)

shinegreymon_burst, ravemon-bm, ghoulmon-black, blacksaintgalgomon, gracenovamon.

## 후속 선택지 (D-19 범위 밖, 사용자 결정 필요)

- armagemon 등에 조그레스 엣지를 when:null 로 허용(원작 근거는 있으나 파트너 조건을 버리는 것).
- 비원작 보충(D-19 가 금지).

## D-20 예외: 원작 조그레스 엣지 허용 (적용)

`--allow-jogress-for-apocalymon-parents` 를 켠 `--write` 로 5개 엣지를 `{from, when:null}` 로 추가했다. 끄면 위 표대로 0건이다. 조그레스 줄의 게임 출처는 로스터 게이트(strict)를 통과하지 못하지만 D-20 이 원작 근거로 인정한다. 파트너 조건은 버린다(claudemon 은 하루 1마리).

| 완전체 | 최종체 | 근거 페이지(Evolves From 줄) |
|---|---|---|
| mugendramon | omegamon | Omegamon.wikitext, `Mugendramon (with Gabumon, Garurumon, ...)` |
| metalseadramon | armagemon | Armagemon.wikitext, `Metal Seadramon (with Diablomon)` |
| mugendramon | armagemon | Armagemon.wikitext, `Mugendramon (with Diablomon)` |
| piemon | armagemon | Armagemon.wikitext, `Piemon (with Diablomon)` |
| mugendramon | zeedmillenniumon | Zeed Millenniumon.wikitext, `Mugendramon (with Millenniumon ... or Chimairamon ...)` |

감사 스크립트(`audit-canon-edges.js --check`)는 이 엣지를 거부하지 않아 별도 예외 목록이 필요 없다.
