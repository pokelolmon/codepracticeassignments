const etch = require('etch')
const {CompositeDisposable} = require('event-kit')
const $ = etch.dom
const TextEditorElement = require('./text-editor-element')
const resizeDetector = require('element-resize-detector')({strategy: 'scroll'})

const DEFAULT_ROWS_PER_TILE = 6
const NORMAL_WIDTH_CHARACTER = 'x'
const DOUBLE_WIDTH_CHARACTER = '我'
const HALF_WIDTH_CHARACTER = 'ﾊ'
const KOREAN_CHARACTER = '세'
const NBSP_CHARACTER = '\u00a0'

module.exports =
class TextEditorComponent {
  constructor (props) {
    this.props = props
    this.element = props.element || new TextEditorElement()
    this.element.initialize(this)
    this.virtualNode = $('atom-text-editor')
    this.virtualNode.domNode = this.element
    this.refs = {}

    this.disposables = new CompositeDisposable()
    this.updateScheduled = false
    this.measurements = null
    this.visible = false
    this.horizontalPositionsToMeasure = new Map() // Keys are rows with positions we want to measure, values are arrays of columns to measure
    this.horizontalPixelPositionsByScreenLineId = new Map() // Values are maps from column to horiontal pixel positions
    this.lineNodesByScreenLineId = new Map()
    this.textNodesByScreenLineId = new Map()
    this.pendingAutoscroll = null
    this.autoscrollTop = -1
    this.lastKeydown = null
    this.lastKeydownBeforeKeypress = null
    this.openedAccentedCharacterMenu = false
    this.cursorsToRender = []

    if (this.props.model) this.observeModel()
    resizeDetector.listenTo(this.element, this.didResize.bind(this))

    etch.updateSync(this)
  }

  update (props) {
    this.props = props
    this.scheduleUpdate()
  }

  scheduleUpdate () {
    if (this.updatedSynchronously) {
      this.updateSync()
    } else if (!this.updateScheduled) {
      this.updateScheduled = true
      etch.getScheduler().updateDocument(() => {
        if (this.updateScheduled) this.updateSync()
      })
    }
  }

  updateSync () {
    this.updateScheduled = false
    if (this.nextUpdatePromise) {
      this.resolveNextUpdatePromise()
      this.nextUpdatePromise = null
      this.resolveNextUpdatePromise = null
    }

    if (this.staleMeasurements.editorDimensions) this.measureEditorDimensions()

    const longestLine = this.getLongestScreenLine()
    let measureLongestLine = false
    if (longestLine !== this.previousLongestLine) {
      this.longestLineToMeasure = longestLine
      this.previousLongestLine = longestLine
      measureLongestLine = true
    }

    if (this.pendingAutoscroll) {
      this.autoscrollVertically()
    }

    this.horizontalPositionsToMeasure.clear()
    etch.updateSync(this)

    if (this.autoscrollTop >= 0) {
      this.refs.scroller.scrollTop = this.autoscrollTop
      this.autoscrollTop = -1
    }
    if (measureLongestLine) this.measureLongestLineWidth(longestLine)
    this.queryCursorsToRender()
    this.measureHorizontalPositions()
    this.positionCursorsToRender()

    etch.updateSync(this)

    this.pendingAutoscroll = null
  }

  render () {
    let style
    if (!this.getModel().getAutoHeight() && !this.getModel().getAutoWidth()) {
      style = {contain: 'strict'}
    }

    let className = 'editor'
    if (this.focused) {
      className += ' is-focused'
    }

    return $('atom-text-editor', {
        className,
        style,
        tabIndex: -1,
        on: {focus: this.didFocus}
      },
      $.div({ref: 'scroller', on: {scroll: this.didScroll}, className: 'scroll-view'},
        $.div({
          style: {
            isolate: 'content',
            width: 'max-content',
            height: 'max-content',
            backgroundColor: 'inherit'
          }
        },
          this.renderGutterContainer(),
          this.renderContent()
        )
      )
    )
  }

  renderGutterContainer () {
    const props = {ref: 'gutterContainer', className: 'gutter-container'}

    if (this.measurements) {
      props.style = {
        position: 'relative',
        willChange: 'transform',
        transform: `translateX(${this.measurements.scrollLeft}px)`,
        zIndex: 1
      }
    }

    return $.div(props, this.renderLineNumberGutter())
  }

  renderLineNumberGutter () {
    const maxLineNumberDigits = Math.max(2, this.getModel().getLineCount().toString().length)

    let props = {
      ref: 'lineNumberGutter',
      className: 'gutter line-numbers',
      'gutter-name': 'line-number'
    }
    let children

    if (this.measurements) {
      props.style = {
        contain: 'strict',
        overflow: 'hidden',
        height: this.getScrollHeight() + 'px',
        width: this.measurements.lineNumberGutterWidth + 'px'
      }

      const approximateLastScreenRow = this.getModel().getApproximateScreenLineCount() - 1
      const firstVisibleRow = this.getFirstVisibleRow()
      const lastVisibleRow = this.getLastVisibleRow()
      const firstTileStartRow = this.getFirstTileStartRow()
      const visibleTileCount = this.getVisibleTileCount()
      const lastTileStartRow = this.getLastTileStartRow()

      children = new Array(visibleTileCount)

      let previousBufferRow = (firstTileStartRow > 0) ? this.getModel().bufferRowForScreenRow(firstTileStartRow - 1) : -1
      for (let tileStartRow = firstTileStartRow; tileStartRow <= lastTileStartRow; tileStartRow += this.getRowsPerTile()) {
        const currentTileEndRow = tileStartRow + this.getRowsPerTile()
        const lineNumberNodes = []

        for (let row = tileStartRow; row < currentTileEndRow && row <= approximateLastScreenRow; row++) {
          const bufferRow = this.getModel().bufferRowForScreenRow(row)
          const foldable = this.getModel().isFoldableAtBufferRow(bufferRow)
          const softWrapped = (bufferRow === previousBufferRow)

          let className = 'line-number'
          let lineNumber
          if (softWrapped) {
            lineNumber = '•'
          } else {
            if (foldable) className += ' foldable'
            lineNumber = (bufferRow + 1).toString()
          }
          lineNumber = NBSP_CHARACTER.repeat(maxLineNumberDigits - lineNumber.length) + lineNumber

          lineNumberNodes.push($.div({className},
            lineNumber,
            $.div({className: 'icon-right'})
          ))

          previousBufferRow = bufferRow
        }

        const tileIndex = (tileStartRow / this.getRowsPerTile()) % visibleTileCount
        const tileHeight = this.getRowsPerTile() * this.measurements.lineHeight

        children[tileIndex] = $.div({
          style: {
            contain: 'strict',
            overflow: 'hidden',
            position: 'absolute',
            height: tileHeight + 'px',
            width: this.measurements.lineNumberGutterWidth + 'px',
            willChange: 'transform',
            transform: `translateY(${this.topPixelPositionForRow(tileStartRow)}px)`,
            backgroundColor: 'inherit'
          }
        }, lineNumberNodes)
      }
    } else {
      children = $.div({className: 'line-number'},
        '0'.repeat(maxLineNumberDigits),
        $.div({className: 'icon-right'})
      )
    }

    return $.div(props, children)
  }

  renderContent () {
    let children
    let style = {
      contain: 'strict',
      overflow: 'hidden'
    }
    if (this.measurements) {
      const width = this.measurements.scrollWidth + 'px'
      const height = this.getScrollHeight() + 'px'
      style.width = width
      style.height = height
      children = [
        this.renderCursorsAndInput(width, height),
        this.renderLineTiles(width, height)
      ]
    } else {
      children = $.div({ref: 'characterMeasurementLine', className: 'line'},
        $.span({ref: 'normalWidthCharacterSpan'}, NORMAL_WIDTH_CHARACTER),
        $.span({ref: 'doubleWidthCharacterSpan'}, DOUBLE_WIDTH_CHARACTER),
        $.span({ref: 'halfWidthCharacterSpan'}, HALF_WIDTH_CHARACTER),
        $.span({ref: 'koreanCharacterSpan'}, KOREAN_CHARACTER)
      )
    }

    return $.div({style}, children)
  }

  renderLineTiles (width, height) {
    if (!this.measurements) return []

    const {lineNodesByScreenLineId, textNodesByScreenLineId} = this

    const firstTileStartRow = this.getFirstTileStartRow()
    const visibleTileCount = this.getVisibleTileCount()
    const lastTileStartRow = this.getLastTileStartRow()

    const displayLayer = this.getModel().displayLayer
    const screenLines = displayLayer.getScreenLines(firstTileStartRow, lastTileStartRow + this.getRowsPerTile())

    let tileNodes = new Array(visibleTileCount)
    for (let tileStartRow = firstTileStartRow; tileStartRow <= lastTileStartRow; tileStartRow += this.getRowsPerTile()) {
      const tileEndRow = tileStartRow + this.getRowsPerTile()
      const lineNodes = []
      for (let row = tileStartRow; row < tileEndRow; row++) {
        const screenLine = screenLines[row - firstTileStartRow]
        if (!screenLine) break
        lineNodes.push($(LineComponent, {
          key: screenLine.id,
          screenLine,
          displayLayer,
          lineNodesByScreenLineId,
          textNodesByScreenLineId
        }))
        if (screenLine === this.longestLineToMeasure) {
          this.longestLineToMeasure = null
        }
      }

      const tileHeight = this.getRowsPerTile() * this.measurements.lineHeight
      const tileIndex = (tileStartRow / this.getRowsPerTile()) % visibleTileCount

      tileNodes[tileIndex] = $.div({
        key: tileIndex,
        style: {
          contain: 'strict',
          position: 'absolute',
          height: tileHeight + 'px',
          width: this.measurements.scrollWidth + 'px',
          willChange: 'transform',
          transform: `translateY(${this.topPixelPositionForRow(tileStartRow)}px)`,
          backgroundColor: 'inherit'
        }
      }, lineNodes)
    }

    if (this.longestLineToMeasure) {
      tileNodes.push($(LineComponent, {
        key: this.longestLineToMeasure.id,
        screenLine: this.longestLineToMeasure,
        displayLayer,
        lineNodesByScreenLineId,
        textNodesByScreenLineId
      }))
      this.longestLineToMeasure = null
    }

    return $.div({
      key: 'lineTiles',
      className: 'lines',
      style: {
        position: 'absolute',
        contain: 'strict',
        width, height
      }
    }, tileNodes)
  }

  renderCursorsAndInput (width, height) {
    const cursorHeight = this.measurements.lineHeight + 'px'

    const children = [this.renderHiddenInput()]

    for (let i = 0; i < this.cursorsToRender.length; i++) {
      const {pixelLeft, pixelTop, pixelWidth} = this.cursorsToRender[i]
      children.push($.div({
        className: 'cursor',
        style: {
          height: cursorHeight,
          width: pixelWidth + 'px',
          transform: `translate(${pixelLeft}px, ${pixelTop}px)`
        }
      }))
    }

    return $.div({
      key: 'cursors',
      className: 'cursors',
      style: {
        position: 'absolute',
        contain: 'strict',
        width, height
      }
    }, children)
  }

  renderHiddenInput () {
    let top, left
    const hiddenInputState = this.getHiddenInputState()
    if (hiddenInputState) {
      top = hiddenInputState.pixelTop
      left = hiddenInputState.pixelLeft
    } else {
      top = 0
      left = 0
    }

    return $.input({
      ref: 'hiddenInput',
      key: 'hiddenInput',
      className: 'hidden-input',
      on: {
        blur: this.didBlur,
        textInput: this.didTextInput,
        keydown: this.didKeydown,
        keyup: this.didKeyup,
        keypress: this.didKeypress
      },
      tabIndex: -1,
      style: {
        position: 'absolute',
        width: '1px',
        height: this.measurements.lineHeight + 'px',
        top: top + 'px',
        left: left + 'px',
        opacity: 0,
        padding: 0,
        border: 0
      }
    })
  }

  queryCursorsToRender () {
    const model = this.getModel()
    const cursorMarkers = model.selectionsMarkerLayer.findMarkers({
      intersectsScreenRowRange: [
        this.getRenderedStartRow(),
        this.getRenderedEndRow() - 1,
      ]
    })
    const lastCursorMarker = model.getLastCursor().getMarker()

    this.cursorsToRender.length = cursorMarkers.length
    this.lastCursorIndex = -1
    for (let i = 0; i < cursorMarkers.length; i++) {
      const cursorMarker = cursorMarkers[i]
      if (cursorMarker === lastCursorMarker) this.lastCursorIndex = i
      const screenPosition = cursorMarker.getHeadScreenPosition()
      const {row, column} = screenPosition
      this.requestHorizontalMeasurement(row, column)
      let columnWidth = 0
      if (model.lineLengthForScreenRow(row) > column) {
        columnWidth = 1
        this.requestHorizontalMeasurement(row, column + 1)
      }
      this.cursorsToRender[i] = {
        screenPosition, columnWidth,
        pixelTop: 0, pixelLeft: 0, pixelWidth: 0
      }
    }
  }

  positionCursorsToRender () {
    const height = this.measurements.lineHeight + 'px'
    for (let i = 0; i < this.cursorsToRender.length; i++) {
      const cursorToRender = this.cursorsToRender[i]
      const {row, column} = cursorToRender.screenPosition

      const pixelTop = this.pixelTopForScreenRow(row)
      const pixelLeft = this.pixelLeftForScreenRowAndColumn(row, column)
      const pixelRight = (cursorToRender.columnWidth === 0)
        ? pixelLeft
        : this.pixelLeftForScreenRowAndColumn(row, column + 1)
      const pixelWidth = pixelRight - pixelLeft

      cursorToRender.pixelTop = pixelTop
      cursorToRender.pixelLeft = pixelLeft
      cursorToRender.pixelWidth = pixelWidth
    }
  }

  getHiddenInputState () {
    if (this.lastCursorIndex >= 0) {
      return this.cursorsToRender[this.lastCursorIndex]
    }
  }

  didAttach () {
    this.intersectionObserver = new IntersectionObserver((entries) => {
      const {intersectionRect} = entries[entries.length - 1]
      if (intersectionRect.width > 0 || intersectionRect.height > 0) {
        this.didShow()
      } else {
        this.didHide()
      }
    })
    this.intersectionObserver.observe(this.element)
    if (this.isVisible()) this.didShow()
  }

  didShow () {
    if (!this.visible) {
      this.visible = true
      this.getModel().setVisible(true)
      if (!this.measurements) this.performInitialMeasurements()
      this.updateSync()
    }
  }

  didHide () {
    if (this.visible) {
      this.visible = false
      this.getModel().setVisible(false)
    }
  }

  didFocus () {
    const {hiddenInput} = this.refs

    // Ensure the input is in the visible part of the scrolled content to avoid
    // the browser trying to auto-scroll to the form-field.
    hiddenInput.style.top = this.measurements.scrollTop + 'px'
    hiddenInput.style.left = this.measurements.scrollLeft + 'px'

    hiddenInput.focus()
    this.focused = true

    // Restore the previous position of the field now that it is focused.
    const currentHiddenInputState = this.getHiddenInputState()
    if (currentHiddenInputState) {
      hiddenInput.style.top = currentHiddenInputState.pixelTop + 'px'
      hiddenInput.style.left = currentHiddenInputState.pixelLeft + 'px'
    } else {
      hiddenInput.style.top = 0
      hiddenInput.style.left = 0
    }

    this.scheduleUpdate()
  }

  didBlur (event) {
    if (this.element !== event.relatedTarget && !this.element.contains(event.relatedTarget)) {
      this.focused = false
      this.scheduleUpdate()
    }
  }

  didScroll () {
    if (this.measureScrollPosition()) {
      this.updateSync()
    }
  }

  didResize () {
    if (this.measureEditorDimensions()) {
      this.scheduleUpdate()
    }
  }

  didTextInput (event) {
    event.stopPropagation()

    // WARNING: If we call preventDefault on the input of a space character,
    // then the browser interprets the spacebar keypress as a page-down command,
    // causing spaces to scroll elements containing editors. This is impossible
    // to test.
    if (event.data !== ' ') event.preventDefault()

    // if (!this.isInputEnabled()) return

    // Workaround of the accented character suggestion feature in macOS. This
    // will only occur when the user is not composing in IME mode. When the user
    // selects a modified character from the macOS menu, `textInput` will occur
    // twice, once for the initial character, and once for the modified
    // character. However, only a single keypress will have fired. If this is
    // the case, select backward to replace the original character.
    if (this.openedAccentedCharacterMenu) {
      this.getModel().selectLeft()
      this.openedAccentedCharacterMenu = false
    }

    this.getModel().insertText(event.data, {groupUndo: true})
  }

  // We need to get clever to detect when the accented character menu is
  // opened on macOS. Usually, every keydown event that could cause input is
  // followed by a corresponding keypress. However, pressing and holding
  // long enough to open the accented character menu causes additional keydown
  // events to fire that aren't followed by their own keypress and textInput
  // events.
  //
  // Therefore, we assume the accented character menu has been deployed if,
  // before observing any keyup event, we observe events in the following
  // sequence:
  //
  // keydown(keyCode: X), keypress, keydown(keyCode: X)
  //
  // The keyCode X must be the same in the keydown events that bracket the
  // keypress, meaning we're *holding* the _same_ key we intially pressed.
  // Got that?
  didKeydown (event) {
    if (this.lastKeydownBeforeKeypress != null) {
      if (this.lastKeydownBeforeKeypress.keyCode === event.keyCode) {
        this.openedAccentedCharacterMenu = true
      }
      this.lastKeydownBeforeKeypress = null
    } else {
      this.lastKeydown = event
    }
  }

  didKeypress () {
    this.lastKeydownBeforeKeypress = this.lastKeydown
    this.lastKeydown = null

    // This cancels the accented character behavior if we type a key normally
    // with the menu open.
    this.openedAccentedCharacterMenu = false
  }

  didKeyup () {
    this.lastKeydownBeforeKeypress = null
    this.lastKeydown = null
  }

  didRequestAutoscroll (autoscroll) {
    this.pendingAutoscroll = autoscroll
    this.scheduleUpdate()
  }

  autoscrollVertically () {
    const {screenRange, options} = this.pendingAutoscroll

    const scrollTop = this.measurements.scrollTop
    const scrollBottom = scrollTop + this.measurements.scrollerHeight
    const screenRangeTop = this.pixelTopForScreenRow(screenRange.start.row)
    const screenRangeBottom = this.pixelTopForScreenRow(screenRange.end.row) + this.measurements.lineHeight
    const verticalScrollMargin = this.getVerticalScrollMargin()

    let desiredScrollTop, desiredScrollBottom
    if (options && options.center) {
      const desiredScrollCenter = (screenRangeTop + screenRangeBottom) / 2
      if (desiredScrollCenter < scrollTop || desiredScrollCenter > scrollBottom) {
        desiredScrollTop = desiredScrollCenter - this.measurements.scrollerHeight / 2
        desiredScrollBottom = desiredScrollCenter + this.measurements.scrollerHeight / 2
      }
    } else {
      desiredScrollTop = screenRangeTop - verticalScrollMargin
      desiredScrollBottom = screenRangeBottom + verticalScrollMargin
    }

    if (!options || options.reversed !== false) {
      if (desiredScrollTop < scrollTop) {
        this.autoscrollTop = desiredScrollTop
        this.measurements.scrollTop = desiredScrollTop
      } else if (desiredScrollBottom > scrollBottom) {
        this.autoscrollTop = desiredScrollBottom - this.measurements.scrollerHeight
        this.measurements.scrollTop = this.autoscrollTop
      }
    } else {
      if (desiredScrollBottom > scrollBottom) {
        this.autoscrollTop = desiredScrollBottom - this.measurements.scrollerHeight
        this.measurements.scrollTop = this.autoscrollTop
      } else if (desiredScrollTop < scrollTop) {
        this.autoscrollTop = desiredScrollTop
        this.measurements.scrollTop = desiredScrollTop
      }
    }
  }

  getVerticalScrollMargin () {
    return Math.min(
     this.getModel().verticalScrollMargin * this.measurements.lineHeight,
     ((this.getLastVisibleRow() - this.getFirstVisibleRow()) * this.measurements.lineHeight) / 2
   )
  }

  performInitialMeasurements () {
    this.measurements = {}
    this.staleMeasurements = {}
    this.measureEditorDimensions()
    this.measureScrollPosition()
    this.measureCharacterDimensions()
    this.measureGutterDimensions()
  }

  measureEditorDimensions () {
    let dimensionsChanged = false
    const scrollerHeight = this.refs.scroller.offsetHeight
    const scrollerWidth = this.refs.scroller.offsetWidth
    if (scrollerHeight !== this.measurements.scrollerHeight) {
      this.measurements.scrollerHeight = scrollerHeight
      dimensionsChanged = true
    }
    if (scrollerWidth !== this.measurements.scrollerWidth) {
      this.measurements.scrollerWidth = scrollerWidth
      dimensionsChanged = true
    }
    return dimensionsChanged
  }

  measureScrollPosition () {
    let scrollPositionChanged = false
    const {scrollTop, scrollLeft} = this.refs.scroller
    if (scrollTop !== this.measurements.scrollTop) {
      this.measurements.scrollTop = scrollTop
      scrollPositionChanged = true
    }
    if (scrollLeft !== this.measurements.scrollLeft) {
      this.measurements.scrollLeft = scrollLeft
      scrollPositionChanged = true
    }
    return scrollPositionChanged
  }

  measureCharacterDimensions () {
    this.measurements.lineHeight = this.refs.characterMeasurementLine.getBoundingClientRect().height
    this.measurements.baseCharacterWidth = this.refs.normalWidthCharacterSpan.getBoundingClientRect().width
    this.measurements.doubleWidthCharacterWidth = this.refs.doubleWidthCharacterSpan.getBoundingClientRect().width
    this.measurements.halfWidthCharacterWidth = this.refs.halfWidthCharacterSpan.getBoundingClientRect().width
    this.measurements.koreanCharacterWidth = this.refs.koreanCharacterSpan.getBoundingClientRect().widt
  }

  measureLongestLineWidth (screenLine) {
    this.measurements.scrollWidth = this.lineNodesByScreenLineId.get(screenLine.id).firstChild.offsetWidth
  }

  measureGutterDimensions () {
    this.measurements.lineNumberGutterWidth = this.refs.lineNumberGutter.offsetWidth
  }

  requestHorizontalMeasurement (row, column) {
    let columns = this.horizontalPositionsToMeasure.get(row)
    if (columns == null) {
      columns = []
      this.horizontalPositionsToMeasure.set(row, columns)
    }
    columns.push(column)
  }

  measureHorizontalPositions () {
    this.horizontalPositionsToMeasure.forEach((columnsToMeasure, row) => {
      columnsToMeasure.sort((a, b) => a - b)

      const screenLine = this.getModel().displayLayer.getScreenLine(row)
      const lineNode = this.lineNodesByScreenLineId.get(screenLine.id)
      const textNodes = this.textNodesByScreenLineId.get(screenLine.id)
      let positionsForLine = this.horizontalPixelPositionsByScreenLineId.get(screenLine.id)
      if (positionsForLine == null) {
        positionsForLine = new Map()
        this.horizontalPixelPositionsByScreenLineId.set(screenLine.id, positionsForLine)
      }

      this.measureHorizontalPositionsOnLine(lineNode, textNodes, columnsToMeasure, positionsForLine)
    })
  }

  measureHorizontalPositionsOnLine (lineNode, textNodes, columnsToMeasure, positions) {
    let lineNodeClientLeft = -1
    let textNodeStartColumn = 0
    let textNodesIndex = 0

    if (!textNodes) debugger

    columnLoop:
    for (let columnsIndex = 0; columnsIndex < columnsToMeasure.length; columnsIndex++) {
      while (textNodesIndex < textNodes.length) {
        const nextColumnToMeasure = columnsToMeasure[columnsIndex]
        if (nextColumnToMeasure === 0) {
          positions.set(0, 0)
          continue columnLoop
        }
        if (positions.has(nextColumnToMeasure)) continue columnLoop
        const textNode = textNodes[textNodesIndex]
        const textNodeEndColumn = textNodeStartColumn + textNode.textContent.length

        if (nextColumnToMeasure <= textNodeEndColumn) {
          let clientPixelPosition
          if (nextColumnToMeasure === textNodeStartColumn) {
            const range = getRangeForMeasurement()
            range.setStart(textNode, 0)
            range.setEnd(textNode, 1)
            clientPixelPosition = range.getBoundingClientRect().left
          } else {
            const range = getRangeForMeasurement()
            range.setStart(textNode, 0)
            range.setEnd(textNode, nextColumnToMeasure - textNodeStartColumn)
            clientPixelPosition = range.getBoundingClientRect().right
          }
          if (lineNodeClientLeft === -1) lineNodeClientLeft = lineNode.getBoundingClientRect().left
          positions.set(nextColumnToMeasure, clientPixelPosition - lineNodeClientLeft)
          continue columnLoop
        } else {
          textNodesIndex++
          textNodeStartColumn = textNodeEndColumn
        }
      }
    }
  }

  pixelTopForScreenRow (row) {
    return row * this.measurements.lineHeight
  }

  pixelLeftForScreenRowAndColumn (row, column) {
    if (column === 0) return 0
    const screenLine = this.getModel().displayLayer.getScreenLine(row)

    if (!this.horizontalPixelPositionsByScreenLineId.has(screenLine.id)) debugger
    return this.horizontalPixelPositionsByScreenLineId.get(screenLine.id).get(column)
  }

  getModel () {
    if (!this.props.model) {
      const TextEditor = require('./text-editor')
      this.props.model = new TextEditor()
      this.observeModel()
    }
    return this.props.model
  }

  observeModel () {
    const {model} = this.props
    const scheduleUpdate = this.scheduleUpdate.bind(this)
    this.disposables.add(model.selectionsMarkerLayer.onDidUpdate(scheduleUpdate))
    this.disposables.add(model.displayLayer.onDidChangeSync(scheduleUpdate))
    this.disposables.add(model.onDidRequestAutoscroll(this.didRequestAutoscroll.bind(this)))
  }

  isVisible () {
    return this.element.offsetWidth > 0 || this.element.offsetHeight > 0
  }

  getBaseCharacterWidth () {
    return this.measurements ? this.measurements.baseCharacterWidth : null
  }

  getScrollTop () {
    return this.measurements ? this.measurements.scrollTop : null
  }

  getScrollLeft () {
    return this.measurements ? this.measurements.scrollLeft : null
  }

  getRowsPerTile () {
    return this.props.rowsPerTile || DEFAULT_ROWS_PER_TILE
  }

  getTileStartRow (row) {
    return row - (row % this.getRowsPerTile())
  }

  getVisibleTileCount () {
    return Math.floor((this.getLastVisibleRow() - this.getFirstVisibleRow()) / this.getRowsPerTile()) + 2
  }

  getFirstTileStartRow () {
    return this.getTileStartRow(this.getFirstVisibleRow())
  }

  getLastTileStartRow () {
    return this.getFirstTileStartRow() + ((this.getVisibleTileCount() - 1) * this.getRowsPerTile())
  }

  getRenderedStartRow () {
    return this.getFirstTileStartRow()
  }

  getRenderedEndRow () {
    return this.getFirstTileStartRow() + this.getVisibleTileCount() * this.getRowsPerTile()
  }

  getFirstVisibleRow () {
    const {scrollTop, lineHeight} = this.measurements
    return Math.floor(scrollTop / lineHeight)
  }

  getLastVisibleRow () {
    const {scrollTop, scrollerHeight, lineHeight} = this.measurements
    return Math.min(
      this.getModel().getApproximateScreenLineCount() - 1,
      this.getFirstVisibleRow() + Math.ceil(scrollerHeight / lineHeight)
    )
  }

  topPixelPositionForRow (row) {
    return row * this.measurements.lineHeight
  }

  getScrollHeight () {
    return this.getModel().getApproximateScreenLineCount() * this.measurements.lineHeight
  }

  getLongestScreenLine () {
    const model = this.getModel()
    // Ensure the spatial index is populated with rows that are currently
    // visible so we *at least* get the longest row in the visible range.
    const renderedEndRow = this.getTileStartRow(this.getLastVisibleRow()) + this.getRowsPerTile()
    model.displayLayer.populateSpatialIndexIfNeeded(Infinity, renderedEndRow)
    return model.screenLineForScreenRow(model.getApproximateLongestScreenRow())
  }

  getNextUpdatePromise () {
    if (!this.nextUpdatePromise) {
      this.nextUpdatePromise = new Promise((resolve) => {
        this.resolveNextUpdatePromise = resolve
      })
    }
    return this.nextUpdatePromise
  }
}

class LineComponent {
  constructor (props) {
    const {displayLayer, screenLine, lineNodesByScreenLineId, textNodesByScreenLineId} = props
    this.props = props
    this.element = document.createElement('div')
    this.element.classList.add('line')
    lineNodesByScreenLineId.set(screenLine.id, this.element)

    const textNodes = []
    textNodesByScreenLineId.set(screenLine.id, textNodes)

    const {lineText, tagCodes} = screenLine
    let startIndex = 0
    let openScopeNode = document.createElement('span')
    this.element.appendChild(openScopeNode)
    for (let i = 0; i < tagCodes.length; i++) {
      const tagCode = tagCodes[i]
      if (tagCode !== 0) {
        if (displayLayer.isCloseTagCode(tagCode)) {
          openScopeNode = openScopeNode.parentElement
        } else if (displayLayer.isOpenTagCode(tagCode)) {
          const scope = displayLayer.tagForCode(tagCode)
          const newScopeNode = document.createElement('span')
          newScopeNode.className = classNameForScopeName(scope)
          openScopeNode.appendChild(newScopeNode)
          openScopeNode = newScopeNode
        } else {
          const textNode = document.createTextNode(lineText.substr(startIndex, tagCode))
          startIndex += tagCode
          openScopeNode.appendChild(textNode)
          textNodes.push(textNode)
        }
      }
    }

    if (startIndex === 0) {
      const textNode = document.createTextNode(' ')
      this.element.appendChild(textNode)
      textNodes.push(textNode)
    }

    if (lineText.endsWith(displayLayer.foldCharacter)) {
      // Insert a zero-width non-breaking whitespace, so that LinesYardstick can
      // take the fold-marker::after pseudo-element into account during
      // measurements when such marker is the last character on the line.
      const textNode = document.createTextNode(ZERO_WIDTH_NBSP)
      this.element.appendChild(textNode)
      textNodes.push(textNode)
    }
  }

  update () {}

  destroy () {
    this.props.lineNodesByScreenLineId.delete(this.props.screenLine.id)
    this.props.textNodesByScreenLineId.delete(this.props.screenLine.id)
  }
}

const classNamesByScopeName = new Map()
function classNameForScopeName (scopeName) {
  let classString = classNamesByScopeName.get(scopeName)
  if (classString == null) {
    classString = scopeName.replace(/\.+/g, ' ')
    classNamesByScopeName.set(scopeName, classString)
  }
  return classString
}

let rangeForMeasurement
function getRangeForMeasurement () {
  if (!rangeForMeasurement) rangeForMeasurement = document.createRange()
  return rangeForMeasurement
}
