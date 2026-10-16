/**
 * SSE 事件总线：给每条推送一个递增 id，保留最近一段供 Last-Event-ID 续传。
 */
export interface BusEvent {
  id: number;
  type: string;
  data: unknown;
}

export type BusListener = (e: BusEvent) => void;

export class EventBus {
  private nextId = 1;
  private readonly buffer: BusEvent[] = [];
  private readonly listeners = new Set<BusListener>();

  constructor(private readonly capacity = 500) {}

  publish(type: string, data: unknown): BusEvent {
    const e: BusEvent = { id: this.nextId++, type, data };
    this.buffer.push(e);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    for (const l of this.listeners) l(e);
    return e;
  }

  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * lastEventId 之后的事件。若缓冲区已经丢掉了其中一部分，返回 gap=true，
   * 客户端应整体刷新（resync）而不是假装没有漏事件。
   */
  since(lastEventId: number): { events: BusEvent[]; gap: boolean } {
    // id 比现有的还大：服务重启过，id 从头编号。
    if (lastEventId >= this.nextId) return { events: [], gap: true };
    const events = this.buffer.filter((e) => e.id > lastEventId);
    const oldest = this.buffer[0]?.id ?? this.nextId;
    return { events, gap: lastEventId < oldest - 1 };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}
