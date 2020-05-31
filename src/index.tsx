
/*
The MIT License (MIT)

Copyright (c) 2019 https://github.com/wubostc/

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
*/

import { TableComponents } from "rc-table/es/interface";
import { vt_components, vt_scroll, _set_components, vt_opts, init } from "./vt";
import { useOnce } from "./use";

const _brower = 1;
const _node = 2;

(function () {
  const env = typeof window === 'object' && window instanceof Window ? _brower : _node;
  if (env & _brower) {
    if (!Object.hasOwnProperty.call(window, "requestAnimationFrame") && !window.requestAnimationFrame)
      throw new Error("Please using the modern browers or appropriate polyfill!");
  }
})();


/**
 * @example
 * 
 * function MyTableComponent() {
 * 
 * // ... your code
 * 
 * 
 * // `set_components` is the same as the setComponents, excepet for the param id.
 * // `vt_scroll` is the same as the VTScroll, excepet for the param id.
 * const [ vt, set_components, vt_scroll ] = useVT();
 * 
 * 
 * return (
 *  <Table
 *   columns={columns}
 *   dataSource={dataSource}
 *   scroll={{ x: 1000, y: 600 }}
 *   components={vt}
 *  />
 * );
 * }
 */
function useVT<RecordType>(opts: vt_opts<RecordType>): [TableComponents<RecordType>,
                                                       (components: TableComponents<RecordType>) => void,
                                                       (param?: { top: number; left: number }) => {
                                                         top: number;
                                                         left: number;
                                                       }]
{
  const ctx = useOnce(init);
  const scroll = useOnce(() => (param?: { top: number; left: number }) => vt_scroll(ctx, param));
  const set = useOnce(() => (components: TableComponents<RecordType>) => _set_components(ctx, components));
  const vt = useOnce(() => vt_components(ctx, opts));

  return [vt, set, scroll];
}

export { useVT };
