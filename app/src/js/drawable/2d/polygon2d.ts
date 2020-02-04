import _ from 'lodash'
import { sprintf } from 'sprintf-js'
import { Cursor, Key, LabelTypeName, ShapeTypeName } from '../../common/types'
import { makeLabel } from '../../functional/states'
import { LabelType, ShapeType, State } from '../../functional/types'
import { Size2D } from '../../math/size2d'
import { Vector2D } from '../../math/vector2d'
import { blendColor, Context2D, encodeControlColor, toCssColor } from '../util'
import { DASH_LINE, MIN_SIZE, OPACITY } from './common'
import { DrawMode, Label2D } from './label2d'
import { Label2DList } from './label2d_list'
import { makeEdge2DStyle, makePathPoint2DStyle, PathPoint2D, PointType } from './path_point2d'
import { Point2D } from './point2d'

const DEFAULT_VIEW_EDGE_STYLE = makeEdge2DStyle({ lineWidth: 4 })
const DEFAULT_VIEW_POINT_STYLE = makePathPoint2DStyle({ radius: 8 })
const DEFAULT_VIEW_HIGH_POINT_STYLE = makePathPoint2DStyle({ radius: 12 })
const DEFAULT_CONTROL_EDGE_STYLE = makeEdge2DStyle({ lineWidth: 10 })
const DEFAULT_CONTROL_POINT_STYLE = makePathPoint2DStyle({ radius: 12 })
const DEFAULT_CONTROL_HIGH_POINT_STYLE = makePathPoint2DStyle({ radius: 14 })

/** list all states */
export enum Polygon2DState {
  FREE,
  DRAW,
  FINISHED,
  RESHAPE,
  MOVE
}

/** list all orientation types */
enum OrientationType {
  COLLINEAR,
  CLOCKWISE,
  COUNTERCLOCKWISE
}

/**
 * polygon 2d label
 */
export class Polygon2D extends Label2D {
  /** array for vertices */
  private _points: PathPoint2D[]
  /** cache shape points for dragging, both move and reshape */
  private _startingPoints: PathPoint2D[]
  /** The hashed list of keys currently down */
  private _keyDownMap: { [key: string]: boolean }
  /** open or closed */
  private _closed: boolean

  constructor (labelList: Label2DList, closed: boolean) {
    super(labelList)
    this._points = []
    this._startingPoints = []
    this._keyDownMap = {}
    this._closed = closed
  }

  /** Get cursor for highlighting */
  public get highlightCursor () {
    if (this.labelId < 0) {
      return Cursor.CROSSHAIR
    } else if (
      this._highlightedHandle >= 0 &&
      this._highlightedHandle < this._points.length
    ) {
      return Cursor.DEFAULT
    } else {
      return Cursor.MOVE
    }
  }

  /**
   * Draw the label on viewing or control canvas
   * @param _context
   * @param _ratio
   * @param _mode
   */
  public draw (context: Context2D, ratio: number, mode: DrawMode): void {
    const self = this
    let numPoints = self._points.length

    if (numPoints === 0) return
    let pointStyle = makePathPoint2DStyle()
    let highPointStyle = makePathPoint2DStyle()
    let edgeStyle = makeEdge2DStyle()
    let assignColor: (i: number) => number[] = () => [0]

    switch (mode) {
      case DrawMode.VIEW:
        pointStyle = _.assign(pointStyle, DEFAULT_VIEW_POINT_STYLE)
        highPointStyle = _.assign(highPointStyle,
          DEFAULT_VIEW_HIGH_POINT_STYLE)
        edgeStyle = _.assign(edgeStyle, DEFAULT_VIEW_EDGE_STYLE)
        assignColor = (i: number): number[] => {
          if (
            i >= 0 &&
            i < this._points.length &&
            this._points[i].type !== PointType.VERTEX
          ) {
            return blendColor(self._color, [255, 255, 255], 0.7)
          } else {
            return self._color
          }
        }
        break
      case DrawMode.CONTROL:
        pointStyle = _.assign(pointStyle, DEFAULT_CONTROL_POINT_STYLE)
        highPointStyle = _.assign(
          highPointStyle, DEFAULT_CONTROL_HIGH_POINT_STYLE)
        edgeStyle = _.assign(edgeStyle, DEFAULT_CONTROL_EDGE_STYLE)
        assignColor = (i: number): number[] => {
          return encodeControlColor(self._index, i)
        }
        break
    }

    // draw line first
    edgeStyle.color = assignColor(this._points.length)
    context.save()
    context.strokeStyle = toCssColor(edgeStyle.color)
    context.lineWidth = edgeStyle.lineWidth
    context.beginPath()
    const begin = self._points[0].toVector().scale(ratio)
    context.moveTo(begin.x, begin.y)
    for (let i = 1; i < numPoints; ++i) {
      const point = self._points[i].toVector().scale(ratio)
      if (self._points[i].type === PointType.CURVE) {
        const nextPoint = self._points[i + 1].toVector().scale(ratio)
        const nextVertex =
          self._points[(i + 2) % numPoints].toVector().scale(ratio)
        context.bezierCurveTo(point.x, point.y,
          nextPoint.x, nextPoint.y, nextVertex.x, nextVertex.y)
        i = i + 2
      } else if (self._points[i].type === PointType.VERTEX) {
        context.lineTo(point.x, point.y)
      }
    }

    if (this._closed) {
      context.lineTo(begin.x, begin.y)
      context.closePath()
      if (mode === DrawMode.VIEW) {
        const fillStyle = self._color.concat(OPACITY)
        context.fillStyle = toCssColor(fillStyle)
        context.fill()
      }
    }
    context.stroke()
    context.restore()

    if (mode === DrawMode.CONTROL || self._selected || self._highlighted) {
      // for bezier curve
      context.save()
      context.setLineDash(DASH_LINE)
      context.beginPath()
      for (let i = 0; i < numPoints; ++i) {
        const point = self._points[i].toVector().scale(ratio)
        const nextPathPoint = self._points[(i + 1) % numPoints]
        const nextPoint = nextPathPoint.toVector().scale(ratio)
        if ((self._points[i].type === PointType.VERTEX &&
          nextPathPoint.type === PointType.CURVE) ||
          self._points[i].type === PointType.CURVE) {
          context.moveTo(point.x, point.y)
          context.lineTo(nextPoint.x, nextPoint.y)
          context.stroke()
        }
      }
      context.closePath()
      context.restore()

      // draw points
      if (this.labelId < 0) {
        numPoints--
      }
      for (let i = 0; i < numPoints; ++i) {
        const point = self._points[i]
        let style = pointStyle
        if (i === self._highlightedHandle) {
          style = highPointStyle
        }
        style.color = assignColor(i)
        if (
          !this.editing ||
          i === self._highlightedHandle ||
          this.labelId < 0
        ) {
          point.draw(context, ratio, style)
        }
      }
    }
  }

  /**
   * Handle mouse down
   * @param coord
   */
  public click (coord: Vector2D): boolean {
    if (this.labelId < 0) {
      // If temporary, add new points on mouse down
      if (this._highlightedHandle > 0) {
        const diff = this._points[0].toVector().subtract(
          this._points[this._highlightedHandle].toVector()
        )
        if (
          diff.dot(diff) < DEFAULT_CONTROL_POINT_STYLE.radius *
            DEFAULT_CONTROL_POINT_STYLE.radius
        ) {
          // Stop adding after clicking on first point
          this._highlightedHandle = this._points.length
          this._points.length--
          this.editing = false
          // Add temporary label for committing
          if (this.isValid()) {
            this._shapes =
              this._points.filter((point) => point.type !== PointType.MID)
            for (const shape of this._shapes) {
              this._labelList.addTemporaryShape(shape)
              shape.associateLabel(this)
            }
            this._labelState.shapes = this._shapes.map((shape) => shape.shapeId)
            this._labelList.addUpdatedLabel(this)
          }
          return true
        }
      }
      if (
        this._highlightedHandle < this._points.length &&
        this._highlightedHandle >= 0
      ) {
        this._points.push(new PathPoint2D(coord.x, coord.y, PointType.VERTEX))
        this._highlightedHandle++
        return true
      }
    } else if (this._highlightedHandle < this._points.length) {
      if (this.isKeyDown(Key.D_LOW) || this.isKeyDown(Key.D_UP)) {
        this.deleteVertex()
      } else if (this.isKeyDown(Key.C_LOW) || this.isKeyDown(Key.C_UP)) {
        this.lineToCurve()
      } else {
        if (this._points[this._highlightedHandle].type === PointType.MID) {
          this.midToVertex()
        }
        this.editing = true
        this.toCache()
      }
      return true
    } else if (this._highlightedHandle === this._points.length) {
      this.editing = true
      this.toCache()
    }

    return false
  }

  /**
   * Handle mouse move
   * @param coord
   * @param _limit
   */
  public drag (delta: Vector2D, _limit: Size2D): boolean {
    if (this.editing) {
      if (this._highlightedHandle < this._points.length) {
        const point = this._points[this._highlightedHandle]
        point.set(point.x + delta.x, point.y + delta.y)
        if (this.labelId >= 0) {
          this._labelList.addUpdatedShape(point)
          this._labelList.addUpdatedLabel(this)
        }
      } else {
        this.move(delta, _limit)
      }
    }
    return true
  }

  /**
   * Handle mouse up
   * @param coord
   */
  public onMouseUp (_coord: Vector2D): boolean {
    return true
  }

  /**
   * handle keyboard down event
   * @param e pressed key
   */
  public onKeyDown (e: string): boolean {
    this._keyDownMap[e] = true
    // if ((e === Key.D_UP || e === Key.D_LOW)) {
    //   this.deleteVertex()
    // }
    return true
  }

  /**
   * handle keyboard up event
   * @param e pressed key
   */
  public onKeyUp (e: string): void {
    delete this._keyDownMap[e]
  }

  /**
   * to check whether the label is valid
   */
  public isValid (): boolean {
    if (this._closed) {
      const lines: PathPoint2D[][] = []
      let l = 0
      let r = 1
      let maxx = Number.MIN_VALUE
      let minx = Number.MAX_VALUE
      let maxy = Number.MIN_VALUE
      let miny = Number.MAX_VALUE
      for (const item of this._points) {
        maxx = Math.max(maxx, item.x)
        minx = Math.min(minx, item.x)
        maxy = Math.max(maxy, item.y)
        miny = Math.min(miny, item.y)
      }
      if ((maxx - minx) * (maxy - miny) < MIN_SIZE) {
        return false
      }
      while (r < this._points.length) {
        if (this._points[r].type === PointType.VERTEX) {
          lines.push([this._points[l], this._points[r]])
          l = r
        }
        r++
      }
      if (this._points[l].type === PointType.VERTEX) {
        lines.push([this._points[l], this._points[0]])
      }
      for (let i = 0; i < lines.length; i++) {
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[i][0].x === lines[j][0].x &&
          lines[i][0].y === lines[j][0].y) {
            continue
          }
          if (lines[i][0].x === lines[j][1].x &&
          lines[i][0].y === lines[j][1].y) {
            continue
          }
          if (lines[i][1].x === lines[j][0].x &&
          lines[i][1].y === lines[j][0].y) {
            continue
          }
          if (lines[i][1].x === lines[j][1].x &&
          lines[i][1].y === lines[j][1].y) {
            continue
          }
          if (this.intersect(lines[i], lines[j])) {
            return false
          }
        }
      }
    } else {
      // TODO: check polyline validation
      if (this._points.length <= 1) {
        return false
      }
    }
    return true
  }

  /** Get shape objects for committing to state */
  public shapeStates (): [number[], ShapeTypeName[], ShapeType[]] {
    const points = this._shapes.map((shape) => shape.toState().shape)
    const types = points.map(() => ShapeTypeName.PATH_POINT_2D)
    return [this._labelState.shapes, types, points]
  }

  /**
   * create new polygon label
   * @param _state
   * @param _start
   */
  public initTemp (state: State, start: Vector2D): void {
    super.initTemp(state, start)
    this.editing = true
    const itemIndex = state.user.select.item

    this._points.push(new PathPoint2D(start.x, start.y, PointType.VERTEX))

    const labelType = this._closed ?
                LabelTypeName.POLYGON_2D : LabelTypeName.POLYLINE_2D
    this._labelState = makeLabel({
      type: labelType, id: -1, item: itemIndex,
      category: [state.user.select.category],
      order: this.order
    })
    this._highlightedHandle = 0
  }

  /**
   * to update the shape of polygon
   * @param _shapes
   */
  public updateState (labelState: LabelType): void {
    super.updateState(labelState)
    this._points = []
    for (const shape of this._shapes) {
      const point = shape as PathPoint2D
      if (point.type === PointType.VERTEX) {
        if (this._points.length !== 0) {
          const prevPoint = this._points[this._points.length - 1]
          if (prevPoint.type === PointType.VERTEX) {
            this._points.push(this.getMidpoint(prevPoint, point))
          }
        }
      }
      this._points.push(point)
    }
    if (this._closed) {
      const last = this._points[this._points.length - 1]
      if (last.type === PointType.VERTEX) {
        this._points.push(this.getMidpoint(last, this._points[0]))
      }
    }
  }

  /**
   * Move the polygon
   * @param _end
   * @param _limit
   */
  private move (delta: Vector2D, _limit: Size2D): void {
    for (let i = 0; i < this._points.length; ++i) {
      this._points[i].x = this._startingPoints[i].x + delta.x
      this._points[i].y = this._startingPoints[i].y + delta.y
    }
    this.setAllShapesUpdated()
  }

  /**
   * delete one vertex in polygon
   */
  private deleteVertex () {
    let numVertices = 0
    for (const point of this._points) {
      if (point.type === PointType.VERTEX) {
        ++numVertices
      }
    }
    const minVertexNumber = this._closed ? 4 : 3
    if (
      numVertices >= minVertexNumber &&
      this._points[this._highlightedHandle].type === PointType.VERTEX
    ) {
      this._points[this._highlightedHandle].unassociateLabel(this)
      this._labelList.addUpdatedShape(this._points[this._highlightedHandle])
      this._labelList.addUpdatedLabel(this)
      let previousVertexIndex = -1
      for (
        let i = this.getPreviousIndex(this._highlightedHandle);
        i >= 0;
        i = this.getPreviousIndex(i)
      ) {
        if (this._points[i].type === PointType.VERTEX) {
          previousVertexIndex = i
          break
        }
        if (this._points[i].type !== PointType.MID) {
          this._points[i].unassociateLabel(this)
          this._labelList.addUpdatedShape(this._points[i])
        }
      }

      let nextVertexIndex = -1
      for (
        let i = this.getNextIndex(this._highlightedHandle);
        i < this._points.length;
        i = this.getNextIndex(i)
      ) {
        if (this._points[i].type === PointType.VERTEX) {
          nextVertexIndex = i
          break
        }
        if (this._points[i].type !== PointType.MID) {
          this._points[i].unassociateLabel(this)
          this._labelList.addUpdatedShape(this._points[i])
        }
      }

      const prevPoint = this._points[previousVertexIndex]
      const nextPoint = this._points[nextVertexIndex]
      const newMidPoint = this.getMidpoint(prevPoint, nextPoint)

      const newPoints = []
      for (
        let i = nextVertexIndex;
        i !== previousVertexIndex;
        i = this.getNextIndex(i)
      ) {
        newPoints.push(this._points[i])
      }
      newPoints.push(this._points[previousVertexIndex])
      newPoints.push(newMidPoint)
      this._points = newPoints

      this.updateShapeRef()
    }
  }

  /**
   * return the midpoint of the line
   * @param prev the previous vertex
   * @param next the next vertex
   */
  private getMidpoint (prev: Point2D, next: Point2D): PathPoint2D {
    const mid = prev.toVector().add(next.toVector()).scale(0.5)
    return new PathPoint2D(mid.x, mid.y, PointType.MID)
  }

  /**
   * return the control points of the bezier curve
   * @param src the source vertex
   * @param dest the next vertex
   */
  private getCurvePoints (src: Point2D, dest: Point2D): PathPoint2D[] {
    const first = src.toVector().scale(2).add(dest.toVector()).scale(1 / 3)
    const point1 = new PathPoint2D(first.x, first.y, PointType.CURVE)
    const second = dest.toVector().scale(2).add(src.toVector()).scale(1 / 3)
    const point2 = new PathPoint2D(second.x, second.y, PointType.CURVE)
    return [point1, point2]
  }

  /**
   * convert a midpoint to a vertex
   */
  private midToVertex (): void {
    const point = this._points[this._highlightedHandle]
    if (point.type !== PointType.MID) {
      throw new Error(sprintf('not a midpoint'))
    }
    point.type = PointType.VERTEX

    const prevPoint =
      this._points[this.getPreviousIndex(this._highlightedHandle)]
    const nextPoint = this._points[this.getNextIndex(this._highlightedHandle)]
    const mid1 = this.getMidpoint(prevPoint, point)
    const mid2 = this.getMidpoint(point, nextPoint)
    this._points.splice(this._highlightedHandle, 0, mid1)
    const nextIndex =
      this.getNextIndex(this.getNextIndex(this._highlightedHandle))
    this._points.splice(
      (nextIndex === 0) ? this._points.length : nextIndex, 0, mid2
    )

    this._highlightedHandle++
    this._labelList.addTemporaryShape(point)
    point.associateLabel(this)
    this.updateShapeRef()
  }

  /**
   * convert a line to a curve and vice-versa
   */
  private lineToCurve (): void {
    const point = this._points[this._highlightedHandle]
    switch (point.type) {
      case PointType.MID: // from midpoint to curve
        const prevPoint =
          this._points[this.getPreviousIndex(this._highlightedHandle)]
        const nextPoint =
          this._points[this.getNextIndex(this._highlightedHandle)]
        const controlPoints = this.getCurvePoints(prevPoint, nextPoint)
        this._points[this._highlightedHandle] = controlPoints[0]
        const nextIndex = this.getNextIndex(this._highlightedHandle)
        this._points.splice(
          (nextIndex === 0) ? this._points.length : nextIndex,
          0,
          controlPoints[1]
        )
        for (const controlPoint of controlPoints) {
          this._labelList.addTemporaryShape(controlPoint)
          controlPoint.associateLabel(this)
        }
        break
      case PointType.CURVE: // from curve to midpoint
        const newMidPointIndex =
          (this._points[this._highlightedHandle - 1].type === PointType.CURVE) ?
            this.getPreviousIndex(this._highlightedHandle) :
            this._highlightedHandle

        this._points[this._highlightedHandle].unassociateLabel(this)
        this._points[newMidPointIndex].unassociateLabel(this)
        this._labelList.addUpdatedShape(this._points[this._highlightedHandle])
        this._labelList.addUpdatedShape(this._points[newMidPointIndex])
        this._labelList.addUpdatedLabel(this)

        this._points.splice(this._highlightedHandle, 1)
        this._points[newMidPointIndex] = this.getMidpoint(
          this._points[this.getNextIndex(newMidPointIndex)],
          this._points[this.getPreviousIndex(newMidPointIndex)]
        )
    }
    this.updateShapeRef()
  }

  /**
   * save current points to cache
   */
  private toCache (): void {
    this._startingPoints = []
    for (const point of this._points) {
      this._startingPoints.push(
        new PathPoint2D(point.x, point.y, point.type))
    }
  }

  /**
   * Given three collinear points p, q, r, the function checks if q lies
   * on line segment pr
   */
  private onSegment (
    p: PathPoint2D, q: PathPoint2D, r: PathPoint2D): boolean {
    if (q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) &&
    q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y)) {
      return true
    }
    return false
  }

  /**
   * To find orientation of ordered triplet
   * The function returns following values
   * 0 -> p, q and r are collinear
   * 1 -> Clockwise
   * 2 -> Counterclockwise
   */
  private orientation (p: PathPoint2D, q: PathPoint2D, r: PathPoint2D):
  OrientationType {
    const val = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y)
    switch (true) {
      case val === 0:
        return OrientationType.COLLINEAR
      case val > 0:
        return OrientationType.CLOCKWISE
      default:
        return OrientationType.COUNTERCLOCKWISE
    }
  }

  /**
   * to check whether two line segments intersect
   */
  private intersect (a: PathPoint2D[], b: PathPoint2D[]): boolean {
    const p1 = a[0]
    const q1 = a[1]
    const p2 = b[0]
    const q2 = b[1]
    const o1 = this.orientation(p1, q1, p2)
    const o2 = this.orientation(p1, q1, q2)
    const o3 = this.orientation(p2, q2, p1)
    const o4 = this.orientation(p2, q2, q1)
    if (o1 !== o2 && o3 !== o4) {
      return true
    }
    if (o1 === OrientationType.COLLINEAR
      && this.onSegment(p1, p2, q1)) return true
    if (o2 === OrientationType.COLLINEAR
      && this.onSegment(p1, q2, q1)) return true
    if (o3 === OrientationType.COLLINEAR
      && this.onSegment(p2, p1, q2)) return true
    if (o4 === OrientationType.COLLINEAR
      && this.onSegment(p2, q1, q2)) return true
    return false
  }

  /**
   * Whether a specific key is pressed down
   * @param key - the key to check
   */
  private isKeyDown (key: Key): boolean {
    return this._keyDownMap[key]
  }

  /**
   * Get index of previous point, circular indexing
   * @param index
   */
  private getPreviousIndex (index: number): number {
    if (!this._closed && index === 0) {
      return -1
    } else {
      return (index - 1 + this._points.length) % this._points.length
    }
  }

  /**
   * Get index of previous point, circular indexing
   * @param index
   */
  private getNextIndex (index: number): number {
    if (!this._closed && index === this._points.length - 1) {
      return -1
    } else {
      return (index + 1) % this._points.length
    }
  }

  /** Remake shape id array in label state */
  private updateShapeRef () {
    this._shapes = this._points.filter(
      (point) => point.type !== PointType.MID
    )
    this._labelState.shapes = this._shapes.map((shape) => shape.shapeId)
    this._labelList.addUpdatedLabel(this)
  }
}
