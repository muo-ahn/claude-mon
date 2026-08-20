#!/usr/bin/env python3
"""도트 이미지 보유 현황 스캐너.

카탈로그(docs/digimon-evolution-lines.yaml 의 정규 진화 단계 138종)를 기준으로
실제 에셋을 훑어 종별 도트 보유 상태를 판정하고, 수동 계획(docs/sprite-plan.yaml)과
병합해 docs/sprite-status.yaml 을 생성한다.

판정 상태(dot):
  ready       팩에 노드가 있고 프레임 PNG(-0, -1)가 모두 존재
  mismatch    프레임은 다 있으나 docs/sprite-plan.yaml 의 dot_mismatch 에 선언된
              알려진 결함 (그림이 해당 종이 아님). ready 집계·커버리지에서 제외
  partial     팩에 노드는 있으나 프레임이 일부만 존재
  source_only 팩에는 없고 dwds 원본 시트만 존재 (추출하면 바로 쓸 수 있음)
  missing     아무 에셋도 없음

사용:
  python3 scripts/sprite_status.py            # 스캔 후 docs/sprite-status.yaml 갱신
  python3 scripts/sprite_status.py --check    # 갱신 없이 검사만, 경고 있으면 exit 1
"""

import argparse
import json
import os
import re
import sys
from collections import Counter, OrderedDict

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LINES_YAML = os.path.join(ROOT, 'docs', 'digimon-evolution-lines.yaml')
ALIASES_YAML = os.path.join(ROOT, 'docs', 'sprite-aliases.yaml')
PLAN_YAML = os.path.join(ROOT, 'docs', 'sprite-plan.yaml')
STATUS_YAML = os.path.join(ROOT, 'docs', 'sprite-status.yaml')
PACKS_DIR = os.path.join(ROOT, 'sprites', 'packs')
SHARED_DIR = os.path.join(ROOT, 'sprites', 'shared')
SHEETS_DIR = os.path.join(ROOT, 'sprites', 'sheets', 'dwds')
GRAPH_PATH = os.path.join(ROOT, 'evolution-graph.json')
NODES_DIR = os.path.join(ROOT, 'sprites', 'nodes')

STAGES = ['baby1', 'baby2', 'child', 'adult', 'perfect', 'ultimate', 'superultimate']
FRAMES = ('0', '1')
VALID_STATUS = {'todo', 'wip', 'done', 'wontfix'}
# 팩 공통 애니메이션 스프라이트. 종에 대응하지 않으므로 orphan 검사에서 뺀다.
NON_SPECIES_SPRITES = {'idle', 'limit80', 'limit95'}
FRAME_SUFFIX = re.compile(r'-[01]\.png$')


def load_yaml(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding='utf-8') as fh:
        return yaml.safe_load(fh) or default


def load_evolution_graph():
    """전역 진화 그래프를 로드하고 역인덱스를 구성한다.

    반환: (nodes, by_id, children_of)
      nodes       — 노드 배열 (원본)
      by_id       — 노드 id → 노드 딕셔너리
      children_of — 부모 id → [자식 노드] (역인접 리스트)
    """
    if not os.path.exists(GRAPH_PATH):
        return [], {}, {}
    with open(GRAPH_PATH, encoding='utf-8') as fh:
        data = json.load(fh)
    nodes = data.get('nodes') or []
    by_id = {nd['id']: nd for nd in nodes}
    children_of = {}
    for node in nodes:
        for link in node.get('evolvesFrom') or []:
            parent = link['from']
            children_of.setdefault(parent, []).append(node)
    return nodes, by_id, children_of


def ancestors(node_id, by_id, acc=None):
    """노드의 모든 조상을 재귀로 수집한다 (자신 포함)."""
    if acc is None:
        acc = set()
    if node_id in acc:
        return acc
    acc.add(node_id)
    node = by_id.get(node_id)
    if not node:
        return acc
    for link in node.get('evolvesFrom') or []:
        ancestors(link['from'], by_id, acc)
    return acc


def descendants(node_id, children_of, acc=None):
    """노드의 모든 후손을 재귀로 수집한다 (자신 포함)."""
    if acc is None:
        acc = set()
    if node_id in acc:
        return acc
    acc.add(node_id)
    for kid in children_of.get(node_id) or []:
        descendants(kid['id'], children_of, acc)
    return acc


def nodes_for_pack(pack_name, by_id, children_of):
    """팩이 렌더할 수 있는 노드 집합을 파생한다.

    팩 디렉터리명 = 로키(child 스테이지) 노드 id. 팩이 필요한 노드 =
    로키의 조상(알·유아기 포함) + 모든 후손.
    scripts/materialize-sprites.js 와 같은 규칙이다.
    """
    rookie = by_id.get(pack_name)
    if not rookie or rookie.get('stage') != 'child':
        return []
    needed = set()
    for nid in ancestors(pack_name, by_id):
        needed.add(nid)
    for nid in descendants(pack_name, children_of):
        needed.add(nid)
    return sorted(needed)


def legacy_sprites_from_tree(pack_dir):
    """pack.json 의 tree(레거시 구조)에서 스프라이트 키 집합을 뽑는다.

    전역 그래프로 이관한 뒤, tree 는 레거시 접두사 파일(adult-0.png 등)을
    '알려진 스프라이트'로 인식하는 대조 용도로만 남는다.
    """
    pack_json = os.path.join(pack_dir, 'pack.json')
    if not os.path.exists(pack_json):
        return set()
    with open(pack_json, encoding='utf-8') as fh:
        data = json.load(fh)
    tree = data.get('tree') or {}
    sprites = set()
    for nodes in tree.values():
        for nd in nodes:
            sprites.add(nd.get('sprite', ''))
    return sprites


def build_catalog(lines):
    """정본 한글명 -> [(line_id, line_ko, stage), ...]"""
    catalog = OrderedDict()
    for line in lines:
        for stage in STAGES:
            for name in line['stages'][stage]:
                catalog.setdefault(name, []).append((line['id'], line['ko'], stage))
    return catalog


def pack_nodes(pack_name, by_id, children_of):
    """전역 그래프에서 이 팩이 렌더할 수 있는 노드를 파생한다.

    팩 디렉터리명이 로키(child 스테이지) 노드 id 이고, 그 로키의 조상 + 모든
    후손이 팩 멤버십이다. (표시명, stage, sprite key) 목록을 반환한다.
    scripts/materialize-sprites.js 와 같은 규칙.
    """
    node_ids = nodes_for_pack(pack_name, by_id, children_of)
    result = []
    for nid in node_ids:
        node = by_id.get(nid)
        if not node:
            continue
        # 노드 id 가 스프라이트 키다 (§B-1). name 은 표시명.
        result.append((node['name'], node['stage'], node['sprite']))
    return result


def frame_state(pack_dir, sprite):
    """프레임 PNG 존재 여부 -> (있는 프레임 수, 전체).

    팩에 없으면 sprites/shared/ 로 폴백한다 (디지타마처럼 라인 공용인 스프라이트).
    """
    have = sum(os.path.exists(os.path.join(pack_dir, f'{sprite}-{i}.png')) for i in FRAMES)
    if have:
        return have, len(FRAMES), False
    shared = sum(os.path.exists(os.path.join(SHARED_DIR, f'{sprite}-{i}.png')) for i in FRAMES)
    return shared, len(FRAMES), bool(shared)


def has_portrait(pack_dir, sprite):
    return all(os.path.exists(os.path.join(pack_dir, f'portrait-{sprite}-{i}.png'))
               for i in FRAMES)


def orphan_sprites(pack_dir, declared, legacy_keys):
    """그래프에 선언되지 않았는데 PNG 만 존재하는 스프라이트 키.

    레거시 접두사(adult-0.png 등 — tree 에 남아있던 접두사 형태)는
    '알려진 레거시'로 분류하여 미선언 경고 대상에서 제외한다.
    """
    names = set()
    for fname in os.listdir(pack_dir):
        if not fname.endswith('.png') or fname.startswith('portrait-'):
            continue
        names.add(FRAME_SUFFIX.sub('', fname))
    undeclared = names - set(declared) - NON_SPECIES_SPRITES - legacy_keys
    return sorted(undeclared)


def duplicate_frame_sprites(pack_dir, nodes, warnings):
    """같은 팩 안에서 이름이 다른 두 스프라이트가 프레임 0 PNG 바이트까지 같으면 경고.

    도트가 이름과 무관하게 복사된 경우를 잡는다 (예: 유년기 도트 자리에
    성장기 도트를 그대로 복사해 채워 넣은 경우). idle 은 애초에 tree 노드가
    아니라 관례상 child/baby 도트의 복사본이라 제외하고, shared/ 로 폴백된
    프레임(공용 알 등 여러 팩이 같은 파일을 정상적으로 공유하는 경우)도 뺀다.
    """
    pack = os.path.basename(pack_dir)
    seen = {}
    for raw_name, stage, sprite in nodes:
        if sprite == 'idle':
            continue
        have, _total, shared = frame_state(pack_dir, sprite)
        if shared or have == 0:
            continue
        path = os.path.join(pack_dir, f'{sprite}-0.png')
        if not os.path.exists(path):
            continue
        with open(path, 'rb') as fh:
            data = fh.read()
        prior = seen.get(data)
        if prior:
            prior_stage, prior_name = prior
            warnings.append(
                f'{pack} 팩의 {prior_stage}({prior_name}) 도트와 {stage}({raw_name}) 도트가 '
                f'프레임 0 바이트까지 동일함 (이름과 무관한 복사본 의심)')
        else:
            seen[data] = (stage, raw_name)


def record(found, name, entry):
    """같은 종이 여러 곳에 있으면 프레임이 더 갖춰진 쪽을 채택."""
    prev = found.get(name)
    if prev is None or entry['frames'] > prev['frames']:
        found[name] = entry


def scan_packs(aliases, catalog, by_id, children_of, warnings):
    """정본명 -> {pack, stage, sprite, frames, frames_total, portrait}

    전역 그래프에서 각 팩의 노드를 파생한다. 레거시 접두사 파일(adult-0.png
    등)은 pack.json tree 에서 추출해 '알려진 레거시'로 분류한다.
    """
    pack_to_catalog = aliases.get('pack_to_catalog') or {}
    sprite_alias = aliases.get('pack_sprite_to_catalog') or {}
    pack_to_line = aliases.get('pack_to_line') or {}
    found, extras = {}, []
    if not os.path.isdir(PACKS_DIR):
        return found, extras

    for pack in sorted(os.listdir(PACKS_DIR)):
        pack_dir = os.path.join(PACKS_DIR, pack)
        if not os.path.exists(os.path.join(pack_dir, 'pack.json')):
            continue
        line_id = pack_to_line.get(pack, pack)

        # 레거시 접두사 집합 — tree 에서 추출한 스프라이트 키 (대조용)
        legacy_keys = legacy_sprites_from_tree(pack_dir)

        declared = []
        nodes = list(pack_nodes(pack, by_id, children_of))

        for raw_name, stage, sprite in nodes:
            declared.append(sprite)
            name = pack_to_catalog.get(raw_name, raw_name)
            have, total, shared = frame_state(pack_dir, sprite)
            entry = {
                'pack': pack, 'stage': stage, 'sprite': sprite,
                'frames': have, 'frames_total': total,
                'portrait': has_portrait(pack_dir, sprite),
            }
            if have == 0:
                # digitama 는 예외 — sprites/shared/ 에 있다.
                if sprite != 'digitama':
                    warnings.append(
                        f'{pack} 팩의 "{raw_name}"({sprite}) 노드에 프레임 PNG가 하나도 없음')
            elif shared:
                entry['shared'] = True
            owners = {o[0] for o in catalog.get(name, [])}
            if owners and line_id not in owners:
                if sprite == stage:
                    # 팩의 본류 단계가 남의 라인 종을 쓰고 있다 — 대개 자리 채우기.
                    warnings.append(
                        f'{pack} 팩의 본류 {stage} 가 "{name}" 인데 이 종은 '
                        f'{"/".join(sorted(owners))} 라인 소속이다 (카탈로그와 어긋남)')
                else:
                    # 분기 스프라이트가 의도적으로 라인을 넘는 경우 — 경고 아님.
                    entry['cross_line'] = sorted(owners)
            record(found, name, entry)
            extras.append((name, entry))

        duplicate_frame_sprites(pack_dir, nodes, warnings)

        for sprite in orphan_sprites(pack_dir, declared, legacy_keys):
            key = f'{pack}:{sprite}'
            name = sprite_alias.get(key)
            if not name:
                warnings.append(
                    f'{key} 스프라이트가 그래프에도 없고 별칭도 없음 '
                    f'(docs/sprite-aliases.yaml 의 pack_sprite_to_catalog 에 추가하거나 '
                    f'레거시 tree 잔여물이면 삭제할 것)')
                continue
            have, total, _shared = frame_state(pack_dir, sprite)
            entry = {
                'pack': pack, 'stage': None, 'sprite': sprite,
                'frames': have, 'frames_total': total,
                'portrait': has_portrait(pack_dir, sprite),
                'undeclared': True,
            }
            record(found, name, entry)
            extras.append((name, entry))
    return found, extras


def scan_sheets(aliases, warnings):
    """정본명 -> 시트 파일명. 매핑 안 된 시트는 경고."""
    sheet_map = aliases.get('sheet_to_catalog') or {}
    out_map = aliases.get('sheet_out_of_catalog') or {}
    found, out_of_catalog = {}, {}
    if not os.path.isdir(SHEETS_DIR):
        return found, out_of_catalog
    for fname in sorted(os.listdir(SHEETS_DIR)):
        stem, ext = os.path.splitext(fname)
        if ext.lower() != '.png':
            continue
        if stem in sheet_map:
            found[sheet_map[stem]] = fname
        elif stem in out_map:
            out_of_catalog[out_map[stem]] = fname
        else:
            warnings.append(
                f'dwds 시트 {fname} 이 어느 종에도 매핑되지 않음 '
                f'(docs/sprite-aliases.yaml 에 추가할 것)')
    return found, out_of_catalog


def classify(name, packs, sheets, dot_mismatch=None):
    hit = packs.get(name)
    if hit:
        if hit['frames'] == hit['frames_total']:
            if dot_mismatch and name in dot_mismatch:
                return 'mismatch', hit
            return 'ready', hit
        if hit['frames'] > 0:
            return 'partial', hit
    if name in sheets:
        return 'source_only', hit
    return 'missing', hit


def merge_plan(plan, catalog, warnings):
    """수동 계획을 정규화하고, 카탈로그에 없는 항목은 경고."""
    normalized = {}
    for name, item in (plan or {}).items():
        if name not in catalog:
            warnings.append(f'sprite-plan.yaml 의 "{name}" 은 카탈로그 138종에 없음')
            continue
        item = dict(item or {})
        status = item.get('status', 'todo')
        if status not in VALID_STATUS:
            warnings.append(
                f'sprite-plan.yaml 의 "{name}" status={status} 는 허용되지 않음 '
                f'({"/".join(sorted(VALID_STATUS))})')
        normalized[name] = item
    return normalized


def cross_check(name, dot, item, warnings):
    """수동 상태와 실제 파일이 어긋나는지 검사."""
    status = item.get('status', 'todo')
    if status == 'done' and dot != 'ready':
        warnings.append(f'{name}: plan status=done 인데 실제 dot={dot}')
    elif status == 'todo' and dot == 'ready':
        warnings.append(f'{name}: 도트가 이미 완성됐는데 plan status=todo (done 으로 갱신 필요)')
    elif status == 'wontfix' and dot == 'ready':
        warnings.append(f'{name}: wontfix 인데 도트가 존재함')


def build_report(catalog, packs, sheets, sheet_extras, pack_extras, plan, warnings, dot_mismatch=None):
    species, by_line = [], OrderedDict()
    counts = Counter()
    portrait_ready = 0

    for name, occurrences in catalog.items():
        dot, hit = classify(name, packs, sheets, dot_mismatch)
        item = plan.get(name, {})
        if item:
            cross_check(name, dot, item, warnings)
        counts[dot] += 1
        portrait = bool(hit and hit['portrait'])
        if portrait:
            portrait_ready += 1

        line_id, line_ko, stage = occurrences[0]
        row = OrderedDict([
            ('ko', name),
            ('line', line_id),
            ('stage', stage),
            ('dot', dot),
            ('pack', hit['pack'] if hit else None),
            ('sprite', hit['sprite'] if hit else None),
            ('portrait', portrait),
            ('sheet', sheets.get(name)),
            ('priority', item.get('priority')),
            ('status', item.get('status', 'done' if dot == 'ready' else 'todo')),
        ])
        if item.get('note'):
            row['note'] = item['note']
        if item.get('reason'):
            row['reason'] = item['reason']
        if len(occurrences) > 1:
            row['shared_with'] = sorted({o[0] for o in occurrences[1:]})
        species.append(row)

        for lid, lko, _stage in occurrences:
            bucket = by_line.setdefault(lid, {'line': lid, 'ko': lko, 'total': 0,
                                              'ready': 0, 'mismatch': 0, 'partial': 0,
                                              'source_only': 0, 'missing': 0})
            bucket['total'] += 1
            bucket[dot] += 1

    for bucket in by_line.values():
        bucket['pct'] = round(100 * bucket['ready'] / bucket['total']) if bucket['total'] else 0

    seen_extra = {}
    for name, entry in pack_extras:
        if name in catalog:
            continue
        if entry['frames'] == 0:
            continue
        seen_extra.setdefault(name, OrderedDict([
            ('ko', name), ('pack', entry['pack']), ('stage', entry['stage']),
            ('source', 'pack'),
        ]))
    for name, fname in sheet_extras.items():
        seen_extra.setdefault(name, OrderedDict([
            ('ko', name), ('pack', None), ('stage', None),
            ('source', f'sheet:{fname}'),
        ]))

    summary = OrderedDict([
        ('total', len(catalog)),
        ('ready', counts['ready']),
        ('mismatch', counts['mismatch']),
        ('partial', counts['partial']),
        ('source_only', counts['source_only']),
        ('missing', counts['missing']),
        ('coverage_pct', round(100 * counts['ready'] / len(catalog)) if catalog else 0),
        ('portrait_ready', portrait_ready),
    ])
    return summary, list(by_line.values()), species, list(seen_extra.values())


class Dumper(yaml.SafeDumper):
    pass


Dumper.add_representer(
    OrderedDict,
    lambda d, data: d.represent_mapping('tag:yaml.org,2002:map', data.items()))

HEADER = """\
# 도트 이미지 보유 현황 — scripts/sprite_status.py 가 생성한다. 직접 수정하지 말 것.
#
# 기준 카탈로그 : docs/digimon-evolution-lines.yaml 의 정규 진화 단계 (아머체·변종 제외)
# 이름 별칭     : docs/sprite-aliases.yaml
# 수동 계획     : docs/sprite-plan.yaml  (우선순위·진행상태는 여기서 고칠 것)
#
# dot: ready(프레임 완비) / mismatch(프레임은 있으나 알려진 결함) / partial(프레임 일부)
#      / source_only(dwds 시트만) / missing
"""


def split_acknowledged(warnings, patterns):
    """sprite-plan.yaml 에서 확인 처리한 경고를 분리한다."""
    live, known = [], []
    for w in warnings:
        if any(p in w for p in patterns or []):
            known.append(w)
        else:
            live.append(w)
    return live, known


def write_report(summary, by_line, species, extras, warnings, acknowledged):
    doc = OrderedDict([
        ('generated_by', 'scripts/sprite_status.py'),
        ('summary', summary),
        ('by_line', by_line),
        ('species', species),
        ('extras', extras),
        ('warnings', warnings),
        ('acknowledged_warnings', acknowledged),
    ])
    body = yaml.dump(doc, Dumper=Dumper, allow_unicode=True,
                     default_flow_style=False, sort_keys=False, width=120)
    with open(STATUS_YAML, 'w', encoding='utf-8') as fh:
        fh.write(HEADER + '\n' + body)


def print_summary(summary, by_line, warnings, acknowledged, species):
    print(f"카탈로그 {summary['total']}종 | ready {summary['ready']} "
          f"/ mismatch {summary['mismatch']} / partial {summary['partial']} "
          f"/ source_only {summary['source_only']} / missing {summary['missing']}"
          f"  → 커버리지 {summary['coverage_pct']}%")
    print(f"초상(portrait) 완비: {summary['portrait_ready']}종\n")

    print('라인별 커버리지')
    for b in sorted(by_line, key=lambda x: (-x['pct'], x['line'])):
        bar = '█' * round(b['pct'] / 10) + '·' * (10 - round(b['pct'] / 10))
        print(f"  {b['ko']:<8} {bar} {b['pct']:>3}%  "
              f"ready {b['ready']:>2}/{b['total']:<2} "
              f"mismatch {b['mismatch']} src {b['source_only']} miss {b['missing']}")

    nxt = [s for s in species if s['dot'] == 'source_only' and s['status'] != 'wontfix']
    if nxt:
        print(f'\n추출만 하면 되는 종 ({len(nxt)}) — dwds 시트 보유')
        print('  ' + ', '.join(s['ko'] for s in nxt))

    mismatched = [s for s in species if s['dot'] == 'mismatch']
    if mismatched:
        print(f'\n알려진 결함 - 파일은 있으나 그림이 다름 ({len(mismatched)}) — docs/sprite-plan.yaml dot_mismatch')
        print('  ' + ', '.join(s['ko'] for s in mismatched))

    if warnings:
        print(f'\n경고 {len(warnings)}건')
        for w in warnings:
            print(f'  - {w}')
    if acknowledged:
        print(f'\n확인 처리된 경고 {len(acknowledged)}건 (--check 통과)')
        for w in acknowledged:
            print(f'  - {w}')
    if not warnings and not acknowledged:
        print('\n경고 없음')


def main():
    ap = argparse.ArgumentParser(description='도트 이미지 보유 현황 스캐너')
    ap.add_argument('--check', action='store_true',
                    help='파일을 쓰지 않고 검사만 수행. 경고가 있으면 exit 1')
    args = ap.parse_args()

    lines = (load_yaml(LINES_YAML) or {}).get('lines') or []
    if not lines:
        sys.exit(f'진화 라인 카탈로그를 읽지 못했다: {LINES_YAML}')
    aliases = load_yaml(ALIASES_YAML, {}) or {}
    plan_doc = load_yaml(PLAN_YAML, {}) or {}

    # 전역 진화 그래프 로드 — Phase B 이후 선언의 정본이다
    _nodes, by_id, children_of = load_evolution_graph()
    if not by_id:
        sys.exit(f'전역 진화 그래프를 읽지 못했다: {GRAPH_PATH}')

    warnings = []
    catalog = build_catalog(lines)
    packs, pack_extras = scan_packs(aliases, catalog, by_id, children_of, warnings)
    sheets, sheet_extras = scan_sheets(aliases, warnings)
    plan = merge_plan(plan_doc.get('plan'), catalog, warnings)
    dot_mismatch = plan_doc.get('dot_mismatch') or {}
    for name in dot_mismatch:
        if name not in catalog:
            warnings.append(f'sprite-plan.yaml 의 dot_mismatch "{name}" 은 카탈로그 138종에 없음')

    summary, by_line, species, extras = build_report(
        catalog, packs, sheets, sheet_extras, pack_extras, plan, warnings, dot_mismatch)
    warnings, acknowledged = split_acknowledged(
        warnings, plan_doc.get('acknowledged_warnings'))

    if not args.check:
        write_report(summary, by_line, species, extras, warnings, acknowledged)
    print_summary(summary, by_line, warnings, acknowledged, species)

    if args.check and warnings:
        sys.exit(1)


if __name__ == '__main__':
    main()
