
/*
The MIT License (MIT)

Copyright (c) 2019 https://github.com/wubostc/

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
*/


import * as React from "react";
import { TableComponents, CustomizeComponent } from "rc-table/es/interface";
import { TableProps as RcTableProps } from 'rc-table/es/Table';
import { useMount, useOnce } from './use';

const { useRef, useState, useCallback, useContext, useEffect, useMemo } = React;

export
interface vt_opts<RecordType> {
  readonly id: number;
  /**
   * @default 5
   */
  overscanRowCount?: number;

  /**
   * this only needs the scroll.y
   */
  scroll: RcTableProps<RecordType>['scroll'];

  /**
   * wheel event(only works on native events).
   */
  onScroll?: ({ left, top, isEnd, }:
    { top: number; left: number; isEnd: boolean }) => void;


  /**
   * @default false
   */
  debug?: boolean;
}

/**
 * `INIT` -> `LOADED` -> `RUNNING` -> `SUSPENDED`
 * `SUSPENDED` -> `WAITING` -> `RUNNING`
 */
enum e_VT_STATE {
  INIT       = 1,
  LOADED     = 2,
  RUNNING    = 4,
  SUSPENDED  = 8,
  WAITING    = 16,
  PROTECTION = 128,
}


type body_t = {
  wrapper?: CustomizeComponent;
  row?: CustomizeComponent;
  cell?: CustomizeComponent;
}

interface RecordType extends Object {
  [x: string]: any;
}

interface VT_CONTEXT<T = RecordType> extends vt_opts<T> {
  _y: number; // will use the Table.scroll.y.
  _raw_y: number | string; // this is the same as the `Table.scroll.y`.

  _vtcomponents: TableComponents<RecordType>; // virtual layer.
  components: TableComponents<RecordType>;    // implementation layer.
  computed_h: number;
  vt_state: e_VT_STATE;
  possible_hight_per_tr: number;
  
  /* 0: needn't to recalculate, > 0: to add, < 0 to subtract */
  re_computed: number;
  row_height: number[];
  row_count: number;
  prev_row_count: number;
  wrap_inst: React.RefObject<HTMLDivElement>;

  // return the last state.
  VTScroll?: (param?: { top: number; left: number }) => { top: number; left: number };

  _React_ptr: any; // a pointer to the instance of `VTable`.


  WH: number;      // Wrapped Height.
                   // it's the newest value of `wrap_inst`'s height to update.

  HND_PAINT: number;      // a handle for Batch Repainting.

  /* stores [begin, end], `INIT`: [-1, -1] */
  PSRB: number[]; // represents the Previous Shadow-Rows Below `trs`.

  /* render with React. */
  _keys2insert: number; // a number of indexes.

  // persistent stroage index when switch `RUNNING` to `SUSPENDED`.
  // it will prevent to change the `ctx._computed_h`.
  _index_persister: Set<number/* index */>;

  // stores the variables for the offset following.
  //  |
  //  |
  //  top
  //  children[index] - head
  //  .
  //  .
  //  .
  //  .
  //  children[index] - tail <= children.len
  //  |
  _offset_top: number/* int */;
  _offset_head: number/* int */;
  _offset_tail: number/* int */;
}




/* overload __DIAGNOSIS__. */
function helper_diagnosis(ctx: VT_CONTEXT): void {
  if (ctx.hasOwnProperty("CLICK~__DIAGNOSIS__")) return;
  Object.defineProperty(ctx, "CLICK~__DIAGNOSIS__", {
    get() {
      console.debug("OoOoOoO DIAGNOSIS OoOoOoO");
      let expect_height = 0;
      for (let i = 0; i < ctx.row_count; ++i) {
        expect_height += ctx.row_height[i];
      }
      let color: string, explain: string;
      if (expect_height > ctx.computed_h) {
        color = "color:rgb(15, 179, 9)"; // green
        explain = "lower than expected";
      } else if (expect_height < ctx.computed_h) {
        color = "color:rgb(202, 61, 81)"; // red
        explain = "higher than expected";
      } else {
        color = "color:rgba(0, 0, 0, 0.85)";
        explain = "normal";
      }
      console.debug(`%c%d(%d)(${explain})`, color, expect_height, ctx.computed_h - expect_height);
      console.debug("OoOoOoOoOoOoOOoOoOoOoOoOo");
    },
    configurable: false,
    enumerable: false,
  });
}



function log_debug(ctx: VT_CONTEXT, msg: string): void {
  if (ctx.debug) {
    const ts = new Date().getTime();
    console.debug(`%c[${ctx.id}][${ts}][${msg}] vt`, "color:#a00", ctx);
  }
}


/**
 * THE EVENTS OF SCROLLING.
 */
const SCROLLEVT_NULL       = (0<<0);
const SCROLLEVT_INIT       = (1<<0);
const SCROLLEVT_RECOMPUTE  = (1<<1);
const SCROLLEVT_RESTORETO  = (1<<2);
const SCROLLEVT_NATIVE     = (1<<3);
const SCROLLEVT_BARRIER    = (1<<4); // It only for `SCROLLEVT_RECOMPUTE`.
// const SCROLLEVT_MASK       = SCROLLEVT_BARRIER | SCROLLEVT_RECOMPUTE;

type SimEvent = {
  target: { scrollTop: number; scrollLeft: number };
  flag: number;
  end?: boolean;
};

// the factory function returns a SimEvent.
function _make_evt(ne: Event): SimEvent {
  const target: any = ne.target;
  return {
    target: {
      scrollTop: target.scrollTop,
      scrollLeft: target.scrollLeft,
    },
    end: target.scrollHeight - target.clientHeight === target.scrollTop,
    flag: SCROLLEVT_NATIVE,
  };
}



/**
 * Default Implementation Layer.
 */
/** AntD.TableComponent.table */
const TableImpl = React.forwardRef<any>(function TableImpl(props, ref) {
  return <table ref={ref} {...props} />;
});
/** AntD.TableComponent.body.wrapper */
function WrapperImpl(props: any): JSX.Element {
  return <tbody {...props} />; 
}
/** AntD.TableComponent.body.row */
const RowImpl = React.forwardRef<any>(function RowImpl(props, ref) {
  return <tr ref={ref} {...props} />;
});



function get_data(children: any[]): any[] {
  return children.find((child) => child && child.props.data).props.data;
}


/**
 * define CONSTANTs.
 */
// const MIN_FRAME = 16;

/**
 * the following functions bind the `ctx`.
 */
/**
 * O(n)
 * returns offset: [head, tail, top] 
 */
function scroll_with_offset(ctx: VT_CONTEXT, top: number, scroll_y: VT_CONTEXT['scroll']['y']): [number, number, number] {

  const {
    row_height,
    row_count,
    possible_hight_per_tr,
    overscanRowCount,
  } = ctx;
  let overscan = overscanRowCount;

  if (typeof scroll_y === "number") {
    ctx._raw_y = scroll_y as number;
    ctx._y = ctx._raw_y;
  } else if (typeof scroll_y === "string") {
    /* a string, like "calc(100vh - 300px)" */
    if (ctx.debug)
      console.warn(`AntD.Table.scroll.y: ${scroll_y}, it may cause performance problems.`);
    ctx._raw_y = scroll_y;
    ctx._y = ctx.wrap_inst.current.parentElement.offsetHeight;
  } else {
    if (ctx.debug)
      console.warn(`AntD.Table.scroll.y: ${scroll_y}, it may cause performance problems.`);
    console.info("VT will not works well, did you forget to set `scroll.y`?");
    ctx._raw_y = null;
    ctx._y = ctx.wrap_inst.current.parentElement.offsetHeight;
  }

  console.assert(ctx._y >= 0);
  // to calc `accumulate_top` with `row_height` and `overscan`.
  let accumulate_top = 0, i = 0;
  for (; i < row_count && accumulate_top <= top; ++i) {
    accumulate_top += row_height[i];
  }
  while (i > 0 && overscan--) {
    accumulate_top -= row_height[--i];
  }
  // the height to render.
  let torender_h = 0, j = i;
  for (; j < row_count && torender_h < ctx._y; ++j) {
    torender_h += (row_height[i] === void 0) ? possible_hight_per_tr : row_height[j];
  }
  j += overscanRowCount * 2;
  if (j > row_count) j = row_count;
  // returns [head, tail, top].
  return [0 | i, 0 | j, 0 | accumulate_top];
}


// set the variables for offset top/head/tail.
function _set_offset(
  ctx: VT_CONTEXT, top: number, head: number, tail: number): void
{
  ctx._offset_top = 0 | top;
  ctx._offset_head = 0 | head;
  ctx._offset_tail = 0 | tail;
}

function _Update_wrap_style(ctx: VT_CONTEXT, h: number): void {
  // a component has unmounted.
  if (!ctx.wrap_inst.current) return;

  if (ctx.vt_state === e_VT_STATE.WAITING) h = 0;
  ctx.wrap_inst.current.style.height = `${h}px`;
  ctx.wrap_inst.current.style.maxHeight = `${h}px`;
}


/** non-block, just create a macro tack, then only update once. */
function update_wrap_style(ctx: VT_CONTEXT, h: number): void {
  if (ctx.WH === h) return;
  ctx.WH = h;
  _Update_wrap_style(ctx, h);
}


// scrolls the parent element to specified location.
function scroll_to(ctx: VT_CONTEXT, top: number, left: number): void {
  if (!ctx.wrap_inst.current) return;
  const ele = ctx.wrap_inst.current.parentElement;
  /** ie */
  ele.scrollTop = top;
  ele.scrollLeft = left;
}


function apply_h(ctx: VT_CONTEXT, idx: number, h: number, identity: "dom" | "shadow"): void {
  console.assert(h !== void 0, `failed to apply height at index ${idx}!`);
  const _h = h - ctx.row_height[idx];
  ctx.row_height[idx] += _h;
  ctx.computed_h += _h;
  if (ctx.debug) console.info("apply", identity, idx, _h);
}


function add_h(ctx: VT_CONTEXT, idx: number, h: number, identity: "dom" | "shadow"): void {
  console.assert(h !== void 0, `failed to add the height at index ${idx}!`);
  ctx.row_height[idx] = h;
  ctx.computed_h += h; // just do add up.
  if (ctx.debug) console.info("add", identity, idx, h);
}


function free_h(ctx: VT_CONTEXT, idx: number, identity: "dom" | "shadow"): void {
  console.assert(ctx.row_height[idx] !== void 0, `failed to free this tr[${idx}].`);
  ctx.computed_h -= ctx.row_height[idx];
  if (ctx.debug) console.info("free", identity, idx, ctx.row_height[idx]);
  if (identity === "dom") ctx.row_height[idx] = 0;
}


function _repainting(ctx: VT_CONTEXT, ms: number): number {
  const fn = (): void => {
    log_debug(ctx, "REPAINTING");

    if (ctx.vt_state === e_VT_STATE.RUNNING) {
      // output to the buffer
      update_wrap_style(ctx, ctx.computed_h);
    }

    // free this handle manually.
    ctx.HND_PAINT = 0;
  }

  if (ms < 0) return window.requestAnimationFrame(fn);
  return window.setTimeout(fn, ms);
}


// a wrapper function for `_repainting`.
function repainting(ctx: VT_CONTEXT): void {
  if (ctx.HND_PAINT > 0) return;
  ctx.HND_PAINT = _repainting(ctx, -1);
}


/** Shadow Rows. */
function srs_diff(
  ctx: VT_CONTEXT, PSR: number[],
  head: number, tail: number, // the range[head, tail) of the DOMs to render.
  begin: number, end: number, prev_begin: number, prev_end: number): void {

  const { row_height, possible_hight_per_tr } = ctx;

  if (begin > prev_begin) {
    for (let i = prev_begin; i < begin; ++i) {
      if (i >= head && i < tail) continue;
      free_h(ctx, i, "shadow");
    }
  } else if (begin < prev_begin) {
    for (let i = begin; i < prev_begin; ++i) {
      if (i >= head && i < tail) continue;
      add_h(ctx, i, row_height[i] || possible_hight_per_tr, "shadow");
    }
  }

  if (end > prev_end) {
    for (let i = prev_end; i < end; ++i) {
      if (i >= head && i < tail) continue;
      add_h(ctx, i, row_height[i] || possible_hight_per_tr, "shadow");
    }
  } else if (end < prev_end) {
    for (let i = end; i < prev_end; ++i) {
      if (i >= head && i < tail) continue;
      free_h(ctx, i, "shadow");
    }
  }

  PSR[0] = begin;
  PSR[1] = end;
}


function set_tr_cnt(ctx: VT_CONTEXT, n: number): void {
  ctx.re_computed = n - ctx.row_count;
  ctx.prev_row_count = ctx.row_count;
  ctx.row_count = n;
}


interface VTableProps<T> extends React.FC {
  style: React.CSSProperties;
  context: React.Context<VT_CONTEXT<T>>;
  [prop: string]: any;
}


function VTable<T>(props: VTableProps<T>) {
  const { style, context, ...rest } = props;

  /*********** inner context ************/
  const _ctx = useRef({
    vt_state: e_VT_STATE.INIT,
    possible_hight_per_tr: -1,
    computed_h: 0,
    re_computed: 0,
    row_height: [],
    row_count: 0,
    prev_row_count: 0,
    PSRB: [-1, -1],
    _keys2insert: 0,
    _index_persister: new Set<number>(),
    _offset_top: 0 | 0,
    _offset_head: 0 | 0,
    _offset_tail: 0 | 1,
    WH: 0,                 // the wrapper's height
  } as VT_CONTEXT<T>).current;

  /*********** context ************/
  const ctx = useContext(context);
  const ctx_val = useRef(Object.assign(ctx, _ctx)).current;

  /*********** DOM ************/
  const inst = React.createRef<HTMLTableElement>();
  const wrap_inst = React.createRef<HTMLDivElement>();

  // the state of scroll event
  const [scroll, setScroll] = useState({
    top: 0, left: 0,
    flag: SCROLLEVT_NULL,
    end: false,
  });


  /*********** scroll event ************/
  const event_queue = useRef<SimEvent[]>([]).current;
  const nevent_queue = useRef<Event[]>([]).current;   // the Native EVENT.

  const HND_RAF = useRef(0); // handle of requestAnimationFrame

  /* eslint-disable prefer-const */
  let RAF_update_self: (timestamp: number) => void;

  /*********** scroll hook ************/
  const scroll_hook = useCallback((e: any) => {
    if (e) {
      if (e.flag) {
        event_queue.push(e);
      } else {
        nevent_queue.push(e);
      }
    }

    if (nevent_queue.length || event_queue.length) {
      if (HND_RAF) cancelAnimationFrame(HND_RAF.current);
      // requestAnimationFrame, ie >= 10
      HND_RAF.current = requestAnimationFrame(RAF_update_self);
    }
  }, []);

  /* requestAnimationFrame callback */
  RAF_update_self = useCallback((timestamp: number) => {
    if (!(ctx.vt_state & e_VT_STATE.RUNNING)) {
      return;
    }

    const nevq = nevent_queue,
          evq  = event_queue;

    let e: SimEvent;
    // consume the `evq` first.
    if (evq.length) {
      e = evq.shift();
    } else if (nevq.length) {
      // take the last event from the `nevq`.
      e = _make_evt(nevq.pop());
      nevq.length = 0;
    } else {
      return;
    }

    const scrollTop = e.target.scrollTop;
    const scrollLeft = e.target.scrollLeft;
    const flag = e.flag;

    if (ctx.debug) {
      console.debug(`[${ctx.id}][SCROLL] top: %d, left: %d`, scrollTop, scrollLeft);
    }


    // checks every tr's height, which will take some time...
    const offset = scroll_with_offset(
                     ctx,
                     scrollTop,
                     ctx.scroll.y);

    const head = offset[0];
    const tail = offset[1];
    const top = offset[2];

    const prev_head = ctx._offset_head;
    const prev_tail = ctx._offset_tail;
    const prev_top = ctx._offset_top;


    switch (flag) {
      case SCROLLEVT_INIT:
        log_debug(ctx, "SCROLLEVT_INIT");

        console.assert(scrollTop === 0 && scrollLeft === 0);
        
        _set_offset(ctx, top, head, tail);
        setScroll({
          top: scrollTop,
          left: scrollLeft,
          flag: SCROLLEVT_INIT,
          end: false,
        });
        break;


      case SCROLLEVT_RECOMPUTE:
        log_debug(ctx, "SCROLLEVT_RECOMPUTE");

        if (head === prev_head && tail === prev_tail && top === prev_top) {
          HND_RAF.current = 0;

          if (event_queue.length) scroll_hook(null); // consume the next.
          return;
        }

        _set_offset(ctx, top, head, tail);
        setScroll({
          top: scrollTop,
          left: scrollLeft,
          flag: SCROLLEVT_RECOMPUTE,
          end: false,
        });
        break;


      // case SCROLLEVT_RESTORETO:
      //   log_debug(ctx, "SCROLLEVT_RESTORETO");

      //   _RC_rerender(ctx, top, head, tail, () => {
      //     // to force update style assign `WH` to 0.
      //     ctx.WH = 0;
      //     update_wrap_style(ctx, ctx.computed_h);

      //     scroll_to(ctx, scrollTop, scrollLeft);
      //     HND_RAF.current = 0;
  
      //     if (event_queue.length) scroll_hook(null); // consume the next.
      //   });
      //   break;


      case SCROLLEVT_NATIVE:
        log_debug(ctx, "SCROLLEVT_NATIVE");

        if (head === prev_head && tail === prev_tail && top === prev_top) {
          HND_RAF.current = 0;
          if (ctx.onScroll) {
            ctx.onScroll({
              top: scrollTop,
              left: scrollLeft,
              isEnd: e.end,
            });
          }
          return;
        }

        _set_offset(ctx, top, head, tail);
        setScroll({
          top: scrollTop,
          left: scrollLeft,
          flag: SCROLLEVT_NATIVE,
          end: e.end,
        });
        break;
    }

  }, []);


  // update DOM style.
  useEffect(() => {
    switch (scroll.flag) {
      case SCROLLEVT_INIT:
        console.assert(scroll.top === 0 && scroll.left === 0);
        scroll_to(ctx, scroll.top, scroll.left);
        HND_RAF.current = 0;
        if (event_queue.length) scroll_hook(null); // consume the next.
        break;

      case SCROLLEVT_RECOMPUTE:
        scroll_to(ctx, scroll.top, scroll.left);
        HND_RAF.current = 0;
        if (event_queue.length) scroll_hook(null); // consume the next.
        break;

      case SCROLLEVT_NATIVE:
        HND_RAF.current = 0;
        if (ctx.onScroll) {
          ctx.onScroll({
            top: scroll.top,
            left: scroll.left,
            isEnd: scroll.end,
          });
        }
        break;

      default:
        break;
    }
  }, [scroll]);


  useEffect(() => {
    ctx.wrap_inst = wrap_inst;
  }, [wrap_inst.current]);


  useEffect(() => {
    switch (ctx.vt_state) {
      case e_VT_STATE.INIT:
        wrap_inst.current.parentElement.onscroll = scroll_hook;
        break;

      case e_VT_STATE.LOADED: // changed by VTRow only.
        ctx.vt_state = e_VT_STATE.RUNNING;

        // force update for initialization
        scroll_hook({
          target: { scrollTop: 0, scrollLeft: 0 },
          flag: SCROLLEVT_INIT,
        });
        break;

      case e_VT_STATE.WAITING:
        // Do you get the previous data back?
        if (get_data(props.children).length) {
          // Y, `WAITING` -> `RUNNING`.
          ctx.vt_state = e_VT_STATE.RUNNING;
        } else {
          // N, keep `WAITING` then just return.
          return;
        }
        break;

      case e_VT_STATE.RUNNING:
        if (ctx.re_computed !== 0) { // rerender
          ctx.re_computed = 0;
          scroll_hook({
            target: { scrollTop: scroll.top, scrollLeft: scroll.left },
            flag: SCROLLEVT_RECOMPUTE,
          });
        }
        break;

      case e_VT_STATE.SUSPENDED: {
        const len = ctx.row_count;
        if (len > 0) {
          // just only switch to `RUNNING`. 
          ctx.vt_state = e_VT_STATE.RUNNING;
        } else {
          /* `SUSPENDED` -> `WAITING` */
          ctx.vt_state = e_VT_STATE.WAITING;
        }
        break;
      }

    }
  });


  style.position = "relative";
  style.top = _ctx._offset_top;
  const { width, ...rest_style } = style;

  const wrap_style = useMemo<React.CSSProperties>(
    () => ({ width, position: "relative", transform: "matrix(1, 0, 0, 1, 0, 0)" }),
    [width]);

  const Table = ctx.components.table;

  return (
    <div
      ref={wrap_inst}
      style={wrap_style}
    >
      <context.Provider value={ctx_val}>
        <Table {...rest} ref={inst} style={rest_style} />
      </context.Provider>
    </div>
  );

}


interface VWrapperProps<T> extends React.FC {
  style: React.CSSProperties;
  context: React.Context<VT_CONTEXT<T>>;
  [prop: string]: any;
}

function VWrapper<T>(props: VWrapperProps<T>) {
  const { children: [measureRow, rows], context, ...restProps } = props;

  const ctx = useContext(context);

  let { _offset_head: head, _offset_tail: tail } = ctx;

  let trs: any[];
  const children = Array.isArray(rows) ? rows : []; // emptyNode if the rows isn't exists.
  let len = children.length;


  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const Wrapper = (ctx.components.body as body_t).wrapper;

  switch (ctx.vt_state) {
    // waitting for loading data as soon, just returns this as following.
    case e_VT_STATE.WAITING:
    case e_VT_STATE.SUSPENDED:
      trs = children.slice(head, tail);
      break;

    case e_VT_STATE.INIT:
      if (len >= 0) {
        console.assert(head === 0);
        console.assert(tail === 1);
        trs = children.slice(head, tail);
        ctx.re_computed = len;
        ctx.prev_row_count = len;
        ctx.row_count = len;
      }
      break;

    case e_VT_STATE.RUNNING: {
      let offset = 0;
      const last_head = ctx._offset_head;
      const last_tail = ctx._offset_tail;
      if (tail > len) {
        offset = tail - len;
        tail -= offset;
        head -= offset;
        if (head < 0) head = 0;
        if (tail < 0) tail = 0;
        // update the `head` and `tail`.
        _set_offset(ctx,
          ctx._offset_top/* NOTE: invalided param, just to fill for this param */,
          head, tail);
      }

      const { PSRB } = ctx;

      if (ctx.row_count !== len) {
        set_tr_cnt(ctx, len);
      }

      len = ctx.row_count;
      const prev_len = ctx.prev_row_count;

      /**
       * start rendering phase.
       * to render rows to filter.
       */
      if (len > prev_len) {
        trs = [];
        /* insert */
        ctx._keys2insert = 0;
        for (let i = head; i < tail; ++i) {
          if (i >= ctx.row_height.length) {
            ctx._keys2insert++;
            // insert a row at index `i` with height `0`.
            ctx.row_height.splice(i, 0, 0);
          }
          trs.push(children[i]);
        }
      } else {
        trs = children.slice(head, tail);
      }

      /**
       * start srs_diff phase.
       * first up, Previous-Shadow-Rows below `trs`,
       * then Previous-Shadow-Rows above `trs`.
       */
      let fixed_PSRB0 = PSRB[0] - offset;
      if (fixed_PSRB0 < 0) fixed_PSRB0 = 0;

      /* PSR's range: [begin, end) */
      if (PSRB[0] === -1) {
        // init Rows.
        const rows = new Array(tail - 1/* substract the first row */).fill(0, 0, tail - 1);
        ctx.row_height = ctx.row_height.concat(rows);
        // init Shadow Rows.
        const shadow_rows = new Array(len - tail).fill(ctx.possible_hight_per_tr, 0, len - tail);
        ctx.row_height = ctx.row_height.concat(shadow_rows);
        ctx.computed_h = ctx.computed_h + ctx.possible_hight_per_tr * (len - tail);

        PSRB[0] = tail;
        PSRB[1] = len;
      } else {
        if (len < prev_len) {
          /* free some rows */
          srs_diff(
            ctx, PSRB,
            last_head, last_tail,
            tail, len, fixed_PSRB0, PSRB[1]);
        } else if (len > prev_len) {
          /* insert some rows */
          srs_diff(
            ctx, PSRB,
            last_head, last_tail,
            tail, len, PSRB[0], PSRB[1]);
        } else {
          PSRB[0] = tail;
          PSRB[1] = len;
        }
      }

      ctx.prev_row_count = ctx.row_count;
    }
      break;

    case e_VT_STATE.LOADED:
      console.assert(false);
      break;
  }


  return (
    <context.Consumer>
      {
        () => {
          return (
            <Wrapper {...restProps}>
              {measureRow}
              {trs}
            </Wrapper>
          );
        }
      }
    </context.Consumer>

  );
}

interface VRowProps<T> extends React.FC {
  style: React.CSSProperties;
  context: VT_CONTEXT<T>;
  [prop: string]: any;
}


function VTRow<T>(props: VRowProps<T>) {

  const inst = React.createRef<HTMLTableRowElement>();

  const { context, ...rest } = props;

  const ctx = context;

  const children = props.children;

  const index: number = children[0].props.index;
  const last_index = useRef<number>(children[0].props.index);


  useEffect(() => {
    if (ctx.vt_state === e_VT_STATE.INIT) {
      ctx.vt_state = e_VT_STATE.LOADED;
      const h = inst.current.offsetHeight;
      if (ctx.possible_hight_per_tr === -1) {
        /* assign only once */
        ctx.possible_hight_per_tr = h;
      }
      ctx.computed_h = 0; // reset initial value.
      add_h(ctx, index, h, "dom");
      // create a timeout task.
      _repainting(ctx, 16);
    } else if (ctx.vt_state === e_VT_STATE.RUNNING) {
      ctx._index_persister.delete(index);
      if (ctx.re_computed >= 0) {
        apply_h(ctx, index, inst.current.offsetHeight, "dom");
      } else {
        // the row moved to another index, so don't need to call `apply_h`.
        // udpate this height at the index directly.
        const h = inst.current.offsetHeight;
        const last_h = ctx.row_height[last_index.current];
  
        if (last_index.current >= ctx._offset_tail) {
          // need to free. so
          // first, free the current height at the index.
          ctx.computed_h -= ctx.row_height[index];
          // then, move and update the height.
          ctx.computed_h += h - last_h;
          // finaly, update the height at the index to ctx.row_height.
          ctx.row_height[index] = h;
        } else {
          // move and update the height.
          ctx.computed_h += h - last_h;
          // finaly, update the height at the index to ctx.row_height.
          ctx.row_height[index] = h;
        }
  
        if (last_index.current !== index) {
          // free the height of the row at the last index to easy to mount a new row.
          ctx.row_height[last_index.current] = 0;
          last_index.current = index;
        }
      }
      repainting(ctx);
    } else {
      console.assert(false); // it will never happen.
    }


    // cleanup
    return () => {
      // `RUNNING` -> `SUSPENDED`
      if (ctx.vt_state === e_VT_STATE.SUSPENDED) {
        ctx._index_persister.add(index);
        return;
      }
  
      if (ctx._keys2insert > 0) {
        ctx._keys2insert--;
        // nothing to do... just return.
        return;
      }
  
      if (ctx.re_computed >= 0) {
        // scrolling or added some rows... just return.
        return;
      }
  
      free_h(ctx, index, "dom");
      repainting(ctx);
    }
  }, [inst.current, index]);


  const Row = (ctx.components.body as body_t).row;
  return <Row {...rest} ref={inst} />;
}




export
function _set_components<T>(ctx: VT_CONTEXT<T>, components: TableComponents<T>): void {
  const { table, body, header } = components;
  ctx.components.body = { ...ctx.components.body, ...body };
  if (body && (body as body_t).cell) {
    (ctx._vtcomponents.body as body_t).cell = (body as body_t).cell;
  } 
  if (header) {
    ctx.components.header = header;
    ctx._vtcomponents.header = header;
  }
  if (table) {
    ctx.components.table = table;
  }
}

export
function init<T>(): VT_CONTEXT<T> {

  const ctx = useRef(React.createContext<VT_CONTEXT<T>>({ } as VT_CONTEXT)).current;
  const ctx_value = useContext(ctx);

  const VTableC = useCallback((props: any) => {
    return <VTable<T> {...props} context={ctx} />;
  }, []);

  const VWrapperC = useCallback((props: any) => {
    return <VWrapper<T> {...props} context={ctx}/>;
  }, []);

  const VRowC = useCallback((props: any) => {
    return <VTRow<T> {...props} context={ctx_value} />;
  }, []);

  if (!ctx_value._vtcomponents) {
    // set the virtual layer.
    ctx_value._vtcomponents = {
      table: VTableC,
      body: {
        wrapper: VWrapperC,
        row: VRowC,
      }
    };
    // set the default implementation layer.
    ctx_value.components = {};
    _set_components(ctx_value, {
      table: TableImpl,
      body: {
        wrapper: WrapperImpl,
        row: RowImpl,
      }
    });
    // start -> `INIT`
    ctx_value.vt_state = e_VT_STATE.INIT;
  }
  return ctx_value;
}



export
function vt_components<T>(ctx: VT_CONTEXT<T>, vt_opts: vt_opts<T>): TableComponents<T> {
  Object.assign(
    ctx,
    {
      overscanRowCount: 5,
      debug: false,
    } as VT_CONTEXT,
    vt_opts);

  if (vt_opts.debug) {
    console.debug(`[${vt_opts.id}] calling VTComponents with`, vt_opts);
  }

  return ctx._vtcomponents;
}


export
function vt_scroll<T>(ctx: VT_CONTEXT<T>, param?: { top: number; left: number }): { top: number; left: number } {
  try {
    return ctx.VTScroll(param);
  } catch {
    throw new Error(`[${0}]You haven't initialized this VT yet.`);
  }
}
