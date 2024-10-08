import { Bool, Field } from '../core.js';
import { Provable } from '../provable.js';
import { Struct, Unconstrained } from '../circuit-value.js';
import { assert } from '../gadgets/common.js';
import { provableFromClass } from '../../bindings/lib/provable-snarky.js';
import { Poseidon, packToFields, ProvableHashable } from '../hash.js';

export {
  MerkleListBase,
  MerkleList,
  MerkleListIteratorBase,
  MerkleListIterator,
  WithHash,
  emptyHash,
  genericHash,
  merkleListHash,
  withHashes,
};

// common base types for both MerkleList and MerkleListIterator

const emptyHash = Field(0);

type WithHash<T> = { previousHash: Field; element: T };

function WithHash<T>(type: ProvableHashable<T>): ProvableHashable<WithHash<T>> {
  return Struct({ previousHash: Field, element: type });
}
function toConstant<T>(type: Provable<T>, node: WithHash<T>): WithHash<T> {
  return {
    previousHash: node.previousHash.toConstant(),
    element: Provable.toConstant(type, node.element),
  };
}

/**
 * Common base type for {@link MerkleList} and {@link MerkleListIterator}
 */
type MerkleListBase<T> = {
  hash: Field;
  data: Unconstrained<WithHash<T>[]>;
};

function MerkleListBase<T>(): ProvableHashable<MerkleListBase<T>> {
  return class extends Struct({ hash: Field, data: Unconstrained.provable }) {
    static empty(): MerkleListBase<T> {
      return { hash: emptyHash, data: Unconstrained.from([]) };
    }
  };
}

// merkle list

/**
 * Dynamic-length list which is represented as a single hash
 *
 * Supported operations are {@link push()} and {@link pop()} and some variants thereof.
 *
 *
 * A Merkle list is generic over its element types, so before using it you must create a subclass for your element type:
 *
 * ```ts
 * class MyList extends MerkleList.create(MyType) {}
 *
 * // now use it
 * let list = MyList.empty();
 *
 * list.push(new MyType(...));
 *
 * let element = list.pop();
 * ```
 *
 * Internal detail: `push()` adds elements to the _start_ of the internal array and `pop()` removes them from the start.
 * This is so that the hash which represents the list is consistent with {@link MerkleListIterator},
 * and so a `MerkleList` can be used as input to `MerkleListIterator.startIterating(list)`
 * (which will then iterate starting from the last pushed element).
 */
class MerkleList<T> implements MerkleListBase<T> {
  hash: Field;
  data: Unconstrained<WithHash<T>[]>;

  constructor({ hash, data }: MerkleListBase<T>) {
    this.hash = hash;
    this.data = data;
  }

  isEmpty() {
    return this.hash.equals(this.Constructor.emptyHash);
  }

  /**
   * Push a new element to the list.
   */
  push(element: T) {
    let previousHash = this.hash;
    this.hash = this.nextHash(previousHash, element);
    this.data.updateAsProver((data) => [
      toConstant(this.innerProvable, { previousHash, element }),
      ...data,
    ]);
  }

  /**
   * Push a new element to the list, if the `condition` is true.
   */
  pushIf(condition: Bool, element: T) {
    let previousHash = this.hash;
    this.hash = Provable.if(
      condition,
      this.nextHash(previousHash, element),
      previousHash
    );
    this.data.updateAsProver((data) =>
      condition.toBoolean()
        ? [toConstant(this.innerProvable, { previousHash, element }), ...data]
        : data
    );
  }

  private popWitness() {
    return Provable.witness(WithHash(this.innerProvable), () => {
      let [value, ...data] = this.data.get();
      let head = value ?? {
        previousHash: this.Constructor.emptyHash,
        element: this.innerProvable.empty(),
      };
      this.data.set(data);
      return head;
    });
  }

  /**
   * Remove the last element from the list and return it.
   *
   * This proves that the list is non-empty, and fails otherwise.
   */
  popExn(): T {
    let { previousHash, element } = this.popWitness();

    let currentHash = this.nextHash(previousHash, element);
    this.hash.assertEquals(currentHash);

    this.hash = previousHash;
    return element;
  }

  /**
   * Remove the last element from the list and return it.
   *
   * If the list is empty, returns a dummy element.
   */
  pop(): T {
    let { previousHash, element } = this.popWitness();
    let isEmpty = this.isEmpty();
    let emptyHash = this.Constructor.emptyHash;

    let currentHash = this.nextHash(previousHash, element);
    currentHash = Provable.if(isEmpty, emptyHash, currentHash);
    this.hash.assertEquals(currentHash);

    this.hash = Provable.if(isEmpty, emptyHash, previousHash);
    let provable = this.innerProvable;
    return Provable.if(isEmpty, provable, provable.empty(), element);
  }

  /**
   * Return the last element, but only remove it if `condition` is true.
   *
   * If the list is empty, returns a dummy element.
   */
  popIf(condition: Bool) {
    let originalHash = this.hash;
    let element = this.pop();

    // if the condition is false, we restore the original state
    this.data.updateAsProver((data) => {
      let node = { previousHash: this.hash, element };
      return condition.toBoolean()
        ? data
        : [toConstant(this.innerProvable, node), ...data];
    });
    this.hash = Provable.if(condition, this.hash, originalHash);

    return element;
  }

  clone(): MerkleList<T> {
    let data = Unconstrained.witness(() => [...this.data.get()]);
    return new this.Constructor({ hash: this.hash, data });
  }

  startIterating(): MerkleListIterator<T> {
    let merkleArray = MerkleListIterator.createFromList<T>(this.Constructor);
    return merkleArray.startIterating(this);
  }

  /**
   * Create a Merkle list type
   *
   * Optionally, you can tell `create()` how to do the hash that pushes a new list element, by passing a `nextHash` function.
   *
   * @example
   * ```ts
   * class MyList extends MerkleList.create(Field, (hash, x) =>
   *   Poseidon.hashWithPrefix('custom', [hash, x])
   * ) {}
   * ```
   */
  static create<T>(
    type: ProvableHashable<T>,
    nextHash: (hash: Field, value: T) => Field = merkleListHash(type),
    emptyHash_ = emptyHash
  ): typeof MerkleList<T> & {
    // override static methods with strict types
    empty: () => MerkleList<T>;
    from: (array: T[]) => MerkleList<T>;
    provable: ProvableHashable<MerkleList<T>>;
  } {
    class MerkleListTBase extends MerkleList<T> {
      static _innerProvable = type;

      static _provable = provableFromClass(MerkleListTBase, {
        hash: Field,
        data: Unconstrained.provable,
      }) as ProvableHashable<MerkleList<T>>;

      static _nextHash = nextHash;
      static _emptyHash = emptyHash_;

      static empty(): MerkleList<T> {
        return new this({ hash: emptyHash_, data: Unconstrained.from([]) });
      }

      static from(array: T[]): MerkleList<T> {
        let { hash, data } = withHashes(array, nextHash, emptyHash_);
        let unconstrained = Unconstrained.witness(() =>
          data.map((x) => toConstant(type, x))
        );
        return new this({ data: unconstrained, hash });
      }

      static get provable(): ProvableHashable<MerkleList<T>> {
        assert(this._provable !== undefined, 'MerkleList not initialized');
        return this._provable;
      }
    }
    // override `instanceof` for subclasses
    return class MerkleListT extends MerkleListTBase {
      static [Symbol.hasInstance](x: any): boolean {
        return x instanceof MerkleListTBase;
      }
    };
  }

  // dynamic subclassing infra
  static _nextHash: ((hash: Field, t: any) => Field) | undefined;
  static _emptyHash: Field | undefined;

  static _provable: ProvableHashable<MerkleList<any>> | undefined;
  static _innerProvable: ProvableHashable<any> | undefined;

  get Constructor() {
    return this.constructor as typeof MerkleList;
  }

  nextHash(hash: Field, value: T): Field {
    assert(
      this.Constructor._nextHash !== undefined,
      'MerkleList not initialized'
    );
    return this.Constructor._nextHash(hash, value);
  }

  static get emptyHash() {
    assert(this._emptyHash !== undefined, 'MerkleList not initialized');
    return this._emptyHash;
  }

  get innerProvable(): ProvableHashable<T> {
    assert(
      this.Constructor._innerProvable !== undefined,
      'MerkleList not initialized'
    );
    return this.Constructor._innerProvable;
  }
}

// merkle list iterator

type MerkleListIteratorBase<T> = {
  readonly hash: Field;
  readonly data: Unconstrained<WithHash<T>[]>;

  /**
   * The merkle list hash of `[data[currentIndex], ..., data[length-1]]` (when hashing from right to left).
   *
   * For example:
   * - If `currentIndex === 0`, then `currentHash === this.hash` is the hash of the entire array.
   * - If `currentIndex === length`, then `currentHash === emptyHash` is the hash of an empty array.
   */
  currentHash: Field;
  /**
   * The index of the element that will be returned by the next call to `next()`.
   */
  currentIndex: Unconstrained<number>;
};

/**
 * MerkleListIterator helps iterating through a Merkle list.
 * This works similar to calling `list.pop()` repeatedly, but maintaining the entire list instead of removing elements.
 *
 * The core method that supports iteration is {@link next()}.
 *
 * ```ts
 * let iterator = MerkleListIterator.startIterating(list);
 *
 * let firstElement = iterator.next();
 * ```
 *
 * We maintain two commitments, both of which are equivalent to a Merkle list hash starting _from the end_ of the array:
 * - One to the entire array, to prove that we start iterating at the beginning.
 * - One to the array from the current index until the end, to efficiently step forward.
 */
class MerkleListIterator<T> implements MerkleListIteratorBase<T> {
  // fixed parts
  readonly data: Unconstrained<WithHash<T>[]>;
  readonly hash: Field;

  // mutable parts
  currentHash: Field;
  currentIndex: Unconstrained<number>;

  constructor(value: MerkleListIteratorBase<T>) {
    Object.assign(this, value);
  }

  assertAtStart() {
    return this.currentHash.assertEquals(this.hash);
  }

  isAtEnd() {
    return this.currentHash.equals(this.Constructor.emptyHash);
  }
  jumpToEnd() {
    this.currentIndex.setTo(
      Unconstrained.witness(() => this.data.get().length)
    );
    this.currentHash = this.Constructor.emptyHash;
  }
  jumpToEndIf(condition: Bool) {
    Provable.asProver(() => {
      if (condition.toBoolean()) {
        this.currentIndex.set(this.data.get().length);
      }
    });
    this.currentHash = Provable.if(
      condition,
      this.Constructor.emptyHash,
      this.currentHash
    );
  }

  next() {
    // next corresponds to `pop()` in MerkleList
    // it returns a dummy element if we're at the end of the array
    let { previousHash, element } = Provable.witness(
      WithHash(this.innerProvable),
      () =>
        this.data.get()[this.currentIndex.get()] ?? {
          previousHash: this.Constructor.emptyHash,
          element: this.innerProvable.empty(),
        }
    );

    let isDummy = this.isAtEnd();
    let emptyHash = this.Constructor.emptyHash;
    let correctHash = this.nextHash(previousHash, element);
    let requiredHash = Provable.if(isDummy, emptyHash, correctHash);
    this.currentHash.assertEquals(requiredHash);

    this.currentIndex.updateAsProver((i) =>
      Math.min(i + 1, this.data.get().length)
    );
    this.currentHash = Provable.if(isDummy, emptyHash, previousHash);

    return Provable.if(
      isDummy,
      this.innerProvable,
      this.innerProvable.empty(),
      element
    );
  }

  clone(): MerkleListIterator<T> {
    let data = Unconstrained.witness(() => [...this.data.get()]);
    let currentIndex = Unconstrained.witness(() => this.currentIndex.get());
    return new this.Constructor({
      data,
      hash: this.hash,
      currentHash: this.currentHash,
      currentIndex,
    });
  }

  /**
   * Create a Merkle array type
   */
  static create<T>(
    type: ProvableHashable<T>,
    nextHash: (hash: Field, value: T) => Field = merkleListHash(type),
    emptyHash_ = emptyHash
  ): typeof MerkleListIterator<T> & {
    from: (array: T[]) => MerkleListIterator<T>;
    startIterating: (list: MerkleListBase<T>) => MerkleListIterator<T>;
    empty: () => MerkleListIterator<T>;
    provable: ProvableHashable<MerkleListIterator<T>>;
  } {
    return class Iterator extends MerkleListIterator<T> {
      static _innerProvable = type;

      static _provable = provableFromClass(Iterator, {
        hash: Field,
        data: Unconstrained.provable,
        currentHash: Field,
        currentIndex: Unconstrained.provable,
      }) satisfies ProvableHashable<MerkleListIterator<T>> as ProvableHashable<
        MerkleListIterator<T>
      >;

      static _nextHash = nextHash;
      static _emptyHash = emptyHash_;

      static from(array: T[]): MerkleListIterator<T> {
        let { hash, data } = withHashes(array, nextHash, emptyHash_);
        let unconstrained = Unconstrained.witness(() =>
          data.map((x) => toConstant(type, x))
        );
        return this.startIterating({ data: unconstrained, hash });
      }

      static startIterating({
        data,
        hash,
      }: MerkleListBase<T>): MerkleListIterator<T> {
        return new this({
          data,
          hash,
          currentHash: hash,
          currentIndex: Unconstrained.from(0),
        });
      }

      static empty(): MerkleListIterator<T> {
        return this.from([]);
      }

      static get provable(): ProvableHashable<MerkleListIterator<T>> {
        assert(
          this._provable !== undefined,
          'MerkleListIterator not initialized'
        );
        return this._provable;
      }
    };
  }

  static createFromList<T>(merkleList: typeof MerkleList<T>) {
    return this.create<T>(
      merkleList.prototype.innerProvable,
      merkleList._nextHash
    );
  }

  // dynamic subclassing infra
  static _nextHash: ((hash: Field, value: any) => Field) | undefined;
  static _emptyHash: Field | undefined;

  static _provable: ProvableHashable<MerkleListIterator<any>> | undefined;
  static _innerProvable: ProvableHashable<any> | undefined;

  get Constructor() {
    return this.constructor as typeof MerkleListIterator;
  }

  nextHash(hash: Field, value: T): Field {
    assert(
      this.Constructor._nextHash !== undefined,
      'MerkleListIterator not initialized'
    );
    return this.Constructor._nextHash(hash, value);
  }

  static get emptyHash() {
    assert(this._emptyHash !== undefined, 'MerkleList not initialized');
    return this._emptyHash;
  }

  get innerProvable(): ProvableHashable<T> {
    assert(
      this.Constructor._innerProvable !== undefined,
      'MerkleListIterator not initialized'
    );
    return this.Constructor._innerProvable;
  }
}

// hash helpers

function genericHash<T>(
  provable: ProvableHashable<T>,
  prefix: string,
  value: T
) {
  let input = provable.toInput(value);
  let packed = packToFields(input);
  return Poseidon.hashWithPrefix(prefix, packed);
}

function merkleListHash<T>(provable: ProvableHashable<T>, prefix = '') {
  return function nextHash(hash: Field, value: T) {
    let input = provable.toInput(value);
    let packed = packToFields(input);
    return Poseidon.hashWithPrefix(prefix, [hash, ...packed]);
  };
}

function withHashes<T>(
  data: T[],
  nextHash: (hash: Field, value: T) => Field,
  emptyHash: Field
): { data: WithHash<T>[]; hash: Field } {
  let n = data.length;
  let arrayWithHashes = Array<WithHash<T>>(n);
  let currentHash = emptyHash;

  for (let i = n - 1; i >= 0; i--) {
    arrayWithHashes[i] = { previousHash: currentHash, element: data[i] };
    currentHash = nextHash(currentHash, data[i]);
  }

  return { data: arrayWithHashes, hash: currentHash };
}
